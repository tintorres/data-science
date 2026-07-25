import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

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

    // --- NLB Security Group ---
    // ✅ FIX: Previously had NO inbound rules and a broken ICMP egress.
    //         Now has proper inbound (port 80) and egress (port 8000 to VPC).
    const nlbSecurityGroup = new ec2.SecurityGroup(this, 'InferenceNlbSecurityGroup', {
      vpc,
      description: 'Security group for Inference NLB',
      allowAllOutbound: false, // explicit egress only
    });

    // Allow inbound HTTP from internet
    nlbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP inbound from internet',
    );

    // Allow NLB to forward to ECS tasks on port 8000
    nlbSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      'Allow NLB to forward to ECS tasks on port 8000',
    );

    // --- ECS Task Security Group ---
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'InferenceTaskSecurityGroup', {
      vpc,
      description: 'Security group for Inference ECS Fargate tasks',
      allowAllOutbound: true, // tasks need outbound for ECR, CloudWatch, etc.
    });

    // Allow inbound on port 8000 only from the NLB security group
    taskSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(nlbSecurityGroup.securityGroupId),
      ec2.Port.tcp(8000),
      'Allow traffic from NLB to container port 8000',
    );

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
      logGroupName: '/ecs/inference-service',
      retention: logs.RetentionDays.ONE_MONTH,
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
    // 9. Network Load Balancer
    //    ✅ FIX 2 — NLB now has a proper security group with inbound +
    //    egress rules (previously: no inbound, broken ICMP egress)
    // ================================================================
    const nlb = new elbv2.NetworkLoadBalancer(this, 'InferenceNlb', {
      vpc,
      internetFacing: true,
      securityGroups: [nlbSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ================================================================
    // 10. Target Group with HTTP health checks on /health
    // ================================================================
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'InferenceTargetGroup', {
      vpc,
      port: 8000,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30), // faster task replacement
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

    // NLB Listener on port 80 → forward to target group
    nlb.addListener('InferenceListener', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
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
      assignPublicIp: false, // tasks stay in private subnets
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },

      // ✅ FIX 3 — healthCheckGracePeriod: 60s → 120s
      //    Must be >= startPeriod so the NLB doesn't deregister the task
      //    before the container has had a chance to pass its first health check.
      healthCheckGracePeriod: cdk.Duration.seconds(120),

      // ✅ FIX 4 — Circuit breaker with rollback
      //    Prevents infinite restart loops. If the new task revision keeps
      //    failing health checks, ECS will automatically roll back to the
      //    last known-good task definition revision.
      circuitBreaker: {
        enable: true,
        rollback: true,
      },

      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },

      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      enableExecuteCommand: true, // allows `aws ecs execute-command` for debugging
    });

    // Register Fargate tasks with the NLB target group
    fargateService.attachToNetworkTargetGroup(targetGroup);

    // ================================================================
    // 12. Stack Outputs
    // ================================================================
    new cdk.CfnOutput(this, 'InferenceEndpointUrl', {
      value: `http://${nlb.loadBalancerDnsName}`,
      description: 'Inference endpoint URL via NLB',
      exportName: 'InferenceEndpointUrl',
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
