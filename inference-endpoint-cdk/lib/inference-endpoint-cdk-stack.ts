import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'; 

export class InferenceEndpointCdk extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ================================================================
    // 1. VPC — 2 AZs, private subnets with NAT for ECR image pulls
    //    Fully destroyed on `cdk destroy`
    // ================================================================
    const vpc = new ec2.Vpc(this, 'InferenceVpc', {
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      natGateways: 1, // 1 NAT GW is sufficient; tasks are in private subnets
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ================================================================
    // 2. Security Groups
    // ================================================================

    // --- ALB Security Group ---
    const albSecurityGroup = new ec2.SecurityGroup(this, 'InferenceAlbSecurityGroup', {
      vpc,
      description: 'Security group for Inference ALB',
      allowAllOutbound: false,
    });

    // Allow inbound HTTP from internet
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP inbound from internet',
    );

    // Allow ALB to forward to ECS tasks on port 8000
    albSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      'Allow ALB to forward to ECS tasks on port 8000',
    );

    // --- ECS Task Security Group ---
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'InferenceTaskSecurityGroup', {
      vpc,
      description: 'Security group for Inference ECS Fargate tasks',
      allowAllOutbound: true,
    });

    // Allow inbound on port 8000 only from the ALB security group
    taskSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8000),
      'Allow traffic from ALB to container port 8000',
    );

    // ALB health checks come from the ALB SG itself, no VPC CIDR rule needed ✅
    // ✅ ADD THIS — NLB health checks originate from NLB node IPs in the VPC, not from the SG
    taskSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),  // 10.0.0.0/16
      ec2.Port.tcp(8000),
      'Allow NLB health check traffic from VPC CIDR',
    );

    // ================================================================
    // 3. ECS Cluster with Container Insights enabled
    // ================================================================
    const cluster = new ecs.Cluster(this, 'InferenceCluster', {
      clusterName: 'InferenceCluster',
      vpc,
      containerInsights: true, // enables CloudWatch Container Insights
    });

    // ================================================================
    // 4. CloudWatch Log Group
    //    RETAIN on destroy so logs survive a `cdk destroy`
    // ================================================================
    const logGroup = new logs.LogGroup(this, 'InferenceLogGroup', {      
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ================================================================
    // 5. IAM Roles — created fresh, destroyed with the stack
    // ================================================================

    // Task Execution Role — used by ECS agent to pull images & push logs
    const executionRole = new iam.Role(this, 'InferenceExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // Task Role — used by the running container (add your model/S3/etc. permissions here)
    const taskRole = new iam.Role(this, 'InferenceTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role assumed by the InferenceContainer at runtime',
    });

    // Allow task to write logs (belt-and-suspenders alongside execution role)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );

    // ================================================================
    // 6. ECR Repository — references your existing image
    //    NOTE: fromRepositoryName does NOT delete the ECR repo on destroy.
    //    If you want the repo destroyed too, replace with `new ecr.Repository`.
    // ================================================================
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this,
      'InferenceEcrRepo',
      'joblib.inference',
    );

    // Grant the execution role permission to pull the image
    ecrRepo.grantPull(executionRole);

    // ================================================================
    // 7. Fargate Task Definition
    //    Architecture: ARM64 (matches your live config)
    //    CPU: 256 (0.25 vCPU) | Memory: 512 MiB
    // ================================================================
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'InferenceTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      
    });

    // ================================================================
    // 8. Container Definition with FIXED health check
    // ================================================================
    const container = taskDefinition.addContainer('InferenceContainer', {
      containerName: 'InferenceContainer',
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      essential: true,

      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'InferenceService',
      }),

      // ✅ FIX 1 — Health check startPeriod: 10s → 120s
      //
      //    Root cause: joblib inference models take 60–180s to load into memory.
      //    ECS was firing health checks after only 10s, failing all 3 retries,
      //    and killing the container before the model finished loading.
      //
      //    During startPeriod, failures do NOT count toward the retry limit.
      //    ⚠️  Tune startPeriod to match your model's actual cold-start time.
      //    Check logs at /ecs/inference-service to measure it.
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval:    cdk.Duration.seconds(30),  // was 15s — reduced pressure during startup
        timeout:     cdk.Duration.seconds(10),  // was 5s  — more tolerance for slow responses
        startPeriod: cdk.Duration.seconds(120), // was 10s — ✅ KEY FIX: grace period for model load
        retries:     3,
      },
    });

    container.addPortMappings({
      containerPort: 8000,
      protocol: ecs.Protocol.TCP,
    });

    // ================================================================
    // 9. Application Load Balancer
    // ================================================================
    const alb = new elbv2.ApplicationLoadBalancer(this, 'InferenceAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ================================================================
    // 10. Target Group with HTTP health checks on /health
    // ================================================================
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'InferenceTargetGroup', {
      vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        enabled: true,
        protocol: elbv2.Protocol.HTTP,
        path: '/health',
        port: '8000',
        healthyHttpCodes: '200',
        interval:                cdk.Duration.seconds(30),
        timeout:                 cdk.Duration.seconds(10),
        healthyThresholdCount:   2,
        unhealthyThresholdCount: 3,
      },
    });

    // ALB Listener on port 80 → forward to target group
    alb.addListener('InferenceListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ================================================================
    // 11. Fargate Service
    // ================================================================
    const fargateService = new ecs.FargateService(this, 'InferenceService', {
        cluster,
        serviceName: 'InferenceEndpointCdk-InferenceService',
        taskDefinition,
        desiredCount: 1,
        securityGroups: [taskSecurityGroup],
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        healthCheckGracePeriod: cdk.Duration.seconds(120),
        circuitBreaker: {
          enable: true,
          rollback: true,
        },
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
        minHealthyPercent: 50,
        maxHealthyPercent: 200,
        enableExecuteCommand: true,
      });

      // Attach ECS service to ALB target group
      fargateService.attachToApplicationTargetGroup(targetGroup);

    // ================================================================
    // 12. CLoudFront Distribution in front of the ALB
    // ================================================================

     const distribution = new cloudfront.Distribution(this, 'InferenceDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          alb.loadBalancerDnsName,   // ✅ correct property on ALB construct
          {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
          }
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    // ================================================================
    // 12. Stack Outputs
    // ================================================================
      // Replace your existing InferenceEndpointUrl output with:
    new cdk.CfnOutput(this, 'InferenceEndpointUrl', {
      value: `https://${distribution.distributionDomainName}`,  // ✅ now HTTPS
      description: 'CloudFront HTTPS URL',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
    });
    
    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'CloudWatchLogGroup', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for container logs',
    });

  }
}
