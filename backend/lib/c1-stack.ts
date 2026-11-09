import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface C1StackProps extends StackProps {
  eventEndsAt: string;
  domainPrefix: string;
  dataTtlDays: number;
  removalPolicy: RemovalPolicy;
  version: string;
  boardDir: string;
  /** Git URL of the CollabOne repo, used by the fix queue project. Can also be set later in the board. */
  toolRepoUrl?: string;
}

const rateRule = (name: string, priority: number, limit: number, scopeDown?: wafv2.CfnWebACL.StatementProperty): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  action: { block: {} },
  statement: { rateBasedStatement: { limit, aggregateKeyType: 'IP', evaluationWindowSec: 300, ...(scopeDown ? { scopeDownStatement: scopeDown } : {}) } },
  visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
});

const managedRule = (name: string, priority: number, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name,
      ...(overrides.length ? { ruleActionOverrides: overrides.map((r) => ({ name: r, actionToUse: { count: {} } })) } : {}),
    },
  },
  visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
});

export class C1Stack extends Stack {
  constructor(scope: Construct, id: string, props: C1StackProps) {
    super(scope, id, props);
    const runtimeParamName = `/c1/${this.stackName}/runtime`;
    const runtimeParamArn = this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: runtimeParamName.slice(1) });

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: props.removalPolicy,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    const pepper = new secretsmanager.Secret(this, 'TokenPepper', {
      description: 'CollabOne: pepper for hashing agent tokens and join codes',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: props.removalPolicy,
    });
    const originVerify = new secretsmanager.Secret(this, 'OriginVerify', {
      description: 'CollabOne: header CloudFront adds so the API only answers through CloudFront',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
      removalPolicy: props.removalPolicy,
    });

    const skillsBucket = new s3.Bucket(this, 'Skills', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(props.dataTtlDays) }],
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.removalPolicy === RemovalPolicy.DESTROY,
    });
    const boardBucket = new s3.Bucket(this, 'Board', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const userPool = new cognito.UserPool(this, 'Humans', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false, tempPasswordValidity: Duration.days(3) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Your CollabOne board login',
        emailBody: 'You are invited to the CollabOne board. Username: {username} Temporary password: {####} Open the board link your host shared, sign in, then set up an authenticator app.',
      },
      removalPolicy: props.removalPolicy,
    });
    const loginDomain = userPool.addDomain('Login', { cognitoDomain: { domainPrefix: props.domainPrefix } });

    const fnDefaults = (name: string, entry: string, timeout: number, memory = 512, env?: Record<string, string>): nodejs.NodejsFunctionProps => ({
      entry: path.join(__dirname, '..', 'src', 'handlers', entry),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: memory,
      timeout: Duration.seconds(timeout),
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: [], format: nodejs.OutputFormat.CJS },
      logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
      environment: env ?? {
        NODE_OPTIONS: '--enable-source-maps',
        TABLE_NAME: table.tableName,
        DATA_TTL_DAYS: String(props.dataTtlDays),
        EVENT_ENDS_AT: props.eventEndsAt,
        PEPPER_SECRET_ARN: pepper.secretArn,
        ORIGIN_SECRET_ARN: originVerify.secretArn,
        RUNTIME_PARAM: runtimeParamName,
        C1_VERSION: props.version,
        TOOL_REPO_URL: props.toolRepoUrl ?? '',
      },
    });
    const readRuntime = new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [runtimeParamArn] });

    const authFn = new nodejs.NodejsFunction(this, 'Authorizer', fnDefaults('Authorizer', 'authorizer.ts', 10, 256));
    table.grantReadData(authFn);
    pepper.grantRead(authFn);
    originVerify.grantRead(authFn);
    authFn.addToRolePolicy(readRuntime);

    const apiFn = new nodejs.NodejsFunction(this, 'Api', fnDefaults('Api', 'api.ts', 20));
    apiFn.addEnvironment('SKILLS_BUCKET', skillsBucket.bucketName);
    table.grantReadWriteData(apiFn);
    pepper.grantRead(apiFn);
    originVerify.grantRead(apiFn);
    apiFn.addToRolePolicy(readRuntime);
    skillsBucket.grantPut(apiFn, 'skills/*');
    skillsBucket.grantRead(apiFn, 'skills/*');
    skillsBucket.grantDelete(apiFn, 'skills/*');

    const sweepFn = new nodejs.NodejsFunction(this, 'Sweep', fnDefaults('Sweep', 'sweep.ts', 55));
    table.grantReadWriteData(sweepFn);
    pepper.grantRead(sweepFn);
    sweepFn.addToRolePolicy(readRuntime);
    new scheduler.Schedule(this, 'SweepSchedule', {
      description: 'CollabOne sweep: leases, deadlines, contest windows',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(sweepFn, { retryAttempts: 0, maxEventAge: Duration.minutes(1) }),
    });

    const httpApi = new apigw.HttpApi(this, 'HttpApi', { description: 'CollabOne API (reachable only through CloudFront)', createDefaultStage: true });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const authorizer = new HttpLambdaAuthorizer('C1Authorizer', authFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization', '$request.header.x-c1-origin-verify'],
      resultsCacheTtl: Duration.seconds(0),
    });
    httpApi.addRoutes({ path: '/api/v1/health', methods: [apigw.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/api/v1/join', methods: [apigw.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/api/v1/{proxy+}', methods: [apigw.HttpMethod.ANY], integration, authorizer });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    defaultStage?.addPropertyOverride('DefaultRouteSettings', { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 });

    const eventApi = new appsync.EventApi(this, 'Events', {
      apiName: `${this.stackName}-events`.slice(0, 50),
      authorizationConfig: {
        authProviders: [
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
          { authorizationType: appsync.AppSyncAuthorizationType.LAMBDA, lambdaAuthorizerConfig: { handler: authFn, resultsCacheTtl: Duration.seconds(0) } },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    });
    const namespace = eventApi.addChannelNamespace('c1', {
      authorizationConfig: {
        publishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    });

    const fanoutFn = new nodejs.NodejsFunction(
      this,
      'Fanout',
      fnDefaults('Fanout', 'fanout.ts', 30, 256, { NODE_OPTIONS: '--enable-source-maps', EVENTS_HTTP_HOST: eventApi.httpDns, C1_VERSION: props.version }),
    );
    namespace.grantPublish(fanoutFn);
    fanoutFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 5,
        reportBatchItemFailures: true,
        parallelizationFactor: 1,
        filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT'), dynamodb: { Keys: { PK: { S: lambda.FilterRule.isEqual('EVENT') } } } })],
      }),
    );

    const eventsAcl = new wafv2.CfnWebACL(this, 'EventsAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'c1-events', sampledRequestsEnabled: true },
      rules: [rateRule('c1-events-rate', 0, 3000)],
    });
    new wafv2.CfnWebACLAssociation(this, 'EventsAclAssociation', { resourceArn: eventApi.apiArn, webAclArn: eventsAcl.attrArn });

    const edgeAcl = new wafv2.CfnWebACL(this, 'EdgeAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'c1-edge', sampledRequestsEnabled: true },
      rules: [
        rateRule('c1-join-rate', 0, 100, {
          byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: '/api/v1/join', textTransformations: [{ priority: 0, type: 'NONE' }] },
        }),
        rateRule('c1-rate', 1, 6000),
        managedRule('AWSManagedRulesCommonRuleSet', 2, ['SizeRestrictions_BODY']),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 3),
      ],
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'BoardHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data:",
            `connect-src 'self' wss://*.appsync-realtime-api.${this.region}.amazonaws.com https://*.appsync-api.${this.region}.amazonaws.com https://${props.domainPrefix}.auth.${this.region}.amazoncognito.com https://cognito-idp.${this.region}.amazonaws.com`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self' https://*.amazoncognito.com",
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        contentTypeOptions: { override: true },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
      },
    });

    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { 'x-c1-origin-verify': originVerify.secretValue.unsafeUnwrap() },
    });
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CollabOne board and API',
      defaultRootObject: 'index.html',
      webAclId: edgeAcl.attrArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(boardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    const boardUrl = `https://${distribution.distributionDomainName}`;
    const client = userPool.addClient('Board', {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      idTokenValidity: Duration.minutes(60),
      accessTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${boardUrl}/`],
        logoutUrls: [`${boardUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    const loginBase = `https://${props.domainPrefix}.auth.${this.region}.amazoncognito.com`;
    const events_ = { httpHost: eventApi.httpDns, realtimeUrl: `wss://${eventApi.realtimeDns}/event/realtime`, namespace: 'c1' };
    new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: runtimeParamName,
      description: 'CollabOne runtime configuration read by the Lambdas',
      stringValue: JSON.stringify({
        boardUrl,
        apiUrl: `${boardUrl}/api/v1`,
        userPoolId: userPool.userPoolId,
        clientId: client.userPoolClientId,
        region: this.region,
        events: events_,
      }),
    });

    const boardConfig = {
      apiBase: '/api/v1',
      events: events_,
      cognito: { region: this.region, userPoolId: userPool.userPoolId, clientId: client.userPoolClientId, domain: loginBase, redirectUri: `${boardUrl}/` },
      version: props.version,
    };
    const sources = [s3deploy.Source.jsonData('config.json', boardConfig)];
    if (fs.existsSync(props.boardDir) && fs.existsSync(path.join(props.boardDir, 'index.html'))) {
      sources.unshift(s3deploy.Source.asset(props.boardDir, { exclude: ['config.json', 'config.example.json', '*.md', 'test', 'test/**', 'node_modules', 'node_modules/**'] }));
    } else {
      sources.unshift(s3deploy.Source.data('index.html', '<!doctype html><title>CollabOne</title><p>Board not built yet.</p>'));
    }
    new s3deploy.BucketDeployment(this, 'DeployBoard', {
      destinationBucket: boardBucket,
      sources,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      memoryLimit: 512,
    });

    new CfnOutput(this, 'BoardUrl', { value: `${boardUrl}/` });
    new CfnOutput(this, 'ApiUrl', { value: `${boardUrl}/api/v1` });
    new CfnOutput(this, 'EventsHttpHost', { value: eventApi.httpDns });
    new CfnOutput(this, 'EventsRealtimeUrl', { value: events_.realtimeUrl });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'LoginDomain', { value: loginDomain.baseUrl() });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
