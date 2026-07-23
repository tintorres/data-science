import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";

export class InferenceEndpointCdk extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------
    // VPC
    // ------------------------------------------------------------
    const vpc = new ec2.Vpc(this, "InferenceVpc", {
      maxAzs: 2,
      natGateways: 1,
    });

    // ------------------------------------------------------------
    // VPC Endpoints for private ECR pulls
    // ------------------------------------------------------------
    new ec2.InterfaceVpcEndpoint(this, "EcrApiEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    new ec2.InterfaceVpcEndpoint(this, "EcrDockerEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    new ec2.GatewayVpcEndpoint(this, "S3Endpoint", {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ------------------------------------------------------------
    // ECS Cluster
    // ------------------------------------------------------------
    const cluster = new ecs.Cluster(this, "InferenceCluster", {
      vpc,
      clusterName: "InferenceCluster",
    });

    // ------------------------------------------------------------
    // ECS Task Execution Role
    // ------------------------------------------------------------
    const executionRole = new iam.Role(this, "InferenceExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    // ------------------------------------------------------------
    // Explicit CloudWatch Log Group
    // ------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, "InferenceLogGroup", {
      logGroupName: "/ecs/inference-service",
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------
    // Fargate Task Definition (ARM64)
    // ------------------------------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, "InferenceTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Container
    taskDef.addContainer("InferenceContainer", {
      image: ecs.ContainerImage.fromRegistry(
        "046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest"
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "InferenceService",
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 8000 }],
    });

    // ------------------------------------------------------------
    // Security Group for Fargate Tasks
    // ------------------------------------------------------------
    const taskSecurityGroup = new ec2.SecurityGroup(this, "InferenceTaskSG", {
      vpc,
      description: "Security group for Fargate inference tasks",
    });

    taskSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      "Allow NLB to reach FastAPI on port 8000"
    );

    // ------------------------------------------------------------
    // Fargate Service (NO built-in NLB)
    // ------------------------------------------------------------
    const service = new ecs.FargateService(this, "InferenceService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [taskSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ------------------------------------------------------------
    // Manual NLB in PRIVATE subnets
    // ------------------------------------------------------------
    const nlb = new elbv2.NetworkLoadBalancer(this, "InferenceNlb", {
      vpc,
      internetFacing: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ------------------------------------------------------------
    // Target Group
    // ------------------------------------------------------------
  
    const targetGroup = new elbv2.NetworkTargetGroup(this, "InferenceTG", {
      vpc,
      port: 8000,
      protocol: elbv2.Protocol.TCP,   // ⭐ NLB requires TCP here
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        port: "8000",
        protocol: elbv2.Protocol.HTTP,   // ⭐ HTTP health checks ARE allowed
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
      },
    });

    // Deregistration delay
    targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "10"
    );

    // ------------------------------------------------------------
    // Listener
    // ------------------------------------------------------------
    nlb.addListener("InferenceListener", {
      port: 8000,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [targetGroup],
    });

    // ------------------------------------------------------------
    // Attach ECS tasks to NLB target group
    // ------------------------------------------------------------
    service.attachToNetworkTargetGroup(targetGroup);

    // ------------------------------------------------------------
    // API Gateway → VPC Link → NLB
    // ------------------------------------------------------------
    const vpcLink = new apigw.VpcLink(this, "InferenceVpcLink", {
      vpcLinkName: "InferenceVpcLink",
      targets: [nlb],
    });

    const api = new apigw.RestApi(this, "InferenceApi", {
      restApiName: "JoblibInferenceApi",
      description: "FastAPI joblib inference via ECS Fargate (NLB).",
      deployOptions: {
        stageName: "prod",
      },
    });

    // /predict
    const predict = api.root.addResource("predict");

    predict.addMethod(
      "POST",
      new apigw.Integration({
        type: apigw.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: "POST",
        uri: `http://${nlb.loadBalancerDnsName}:8000/predict`,
        options: {
          connectionType: apigw.ConnectionType.VPC_LINK,
          vpcLink,
        },
      })
    );

    // /health passthrough
    const health = api.root.addResource("health");

    health.addMethod(
      "GET",
      new apigw.Integration({
        type: apigw.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: "GET",
        uri: `http://${nlb.loadBalancerDnsName}:8000/health`,
        options: {
          connectionType: apigw.ConnectionType.VPC_LINK,
          vpcLink,
        },
      })
    );

    new cdk.CfnOutput(this, "InferenceUrl", {
      value: `${api.url}predict`,
    });
  }
}
