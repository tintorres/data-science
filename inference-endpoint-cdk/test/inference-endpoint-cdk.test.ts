import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { InferenceEndpointCdk } from '../lib/inference-endpoint-cdk-stack';

// ─────────────────────────────────────────────────────────────────
// Synthesize once — reuse across all tests
// ─────────────────────────────────────────────────────────────────
let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new InferenceEndpointCdk(app, 'TestStack', {
   // env: { account: '046576049723', region: 'ap-southeast-2' },
  });
  template = Template.fromStack(stack);
});

// ================================================================
// 1. VPC
// ================================================================
describe('VPC', () => {
  test('creates a VPC with CIDR 10.0.0.0/16', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  test('creates exactly 1 NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('creates 4 subnets — 2 public + 2 private across 2 explicit AZs', () => {
    // 2 AZs × 2 subnet types (Public + Private) = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('creates an Internet Gateway', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  });
});

// ================================================================
// 2. Security Groups
// ================================================================
describe('Security Groups', () => {

  // ── NLB Security Group ────────────────────────────────────────

  test('NLB security group is created with correct description', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Inference NLB',
    });
  });

  test('NLB security group allows inbound TCP 80 from 0.0.0.0/0 (inline)', () => {
    // Peer.ipv4() ingress → always inlined into SecurityGroupIngress array
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Inference NLB',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0',
        }),
      ]),
    });
  });

  /*
  test('NLB security group egress TCP 8000 to VPC CIDR (separate resource)', () => {
    // allowAllOutbound:false + addEgressRule(Peer.ipv4()) → separate resource
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      IpProtocol: 'tcp',
      FromPort: 8000,
      ToPort: 8000,
      CidrIp: '10.0.0.0/16',
      GroupId: Match.anyValue(),
    });
  });
  */

  // ── Task Security Group ───────────────────────────────────────

  test('Task security group is created with correct description', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Inference ECS Fargate tasks',
    });
  });

  test('Task security group allows inbound TCP 8000 from NLB SG (inline)', () => {
    // Peer.securityGroupId() between two SGs in the SAME stack
    // → CDK inlines the rule into the target SG's SecurityGroupIngress array
    // → AWS::EC2::SecurityGroupIngress resource count will be 0
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Inference ECS Fargate tasks',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 8000,
          ToPort: 8000,
          SourceSecurityGroupId: Match.anyValue(),
        }),
      ]),
    });
  });

  test('Task security group allows all outbound traffic (inline)', () => {
    // allowAllOutbound:true → default -1 rule inlined into SecurityGroupEgress
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Inference ECS Fargate tasks',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: '-1',
          CidrIp: '0.0.0.0/0',
        }),
      ]),
    });
  });

  // ── Sanity: no separate SecurityGroupIngress resources ────────

  test('zero standalone AWS::EC2::SecurityGroupIngress resources (all inlined)', () => {
    // Both SGs are in the same stack → CDK inlines all cross-SG rules
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });
});

// ================================================================
// 3. ECS Cluster
// ================================================================
describe('ECS Cluster', () => {
  test('creates an ECS cluster named InferenceCluster', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'InferenceCluster',
    });
  });

  test('Container Insights is enabled', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: Match.arrayWith([
        Match.objectLike({ Name: 'containerInsights', Value: 'enabled' }),
      ]),
    });
  });
});

// ================================================================
// 4. IAM Roles
// ================================================================
describe('IAM Roles', () => {
  test('execution role trusts ecs-tasks.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('AmazonECSTaskExecutionRolePolicy'),
            ]),
          ]),
        }),
      ]),
    });
  });

  test('task role trusts ecs-tasks.amazonaws.com with runtime description', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Description: 'Role assumed by the InferenceContainer at runtime',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });
});

// ================================================================
// 5. Task Definition
// ================================================================
describe('Fargate Task Definition', () => {
  test('uses FARGATE compatibility with awsvpc network mode', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
    });
  });

  test('CPU is 256 and Memory is 512 (as strings in CFN)', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
    });
  });

  test('runtime platform is ARM64 Linux', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
  });

  test('container is named InferenceContainer and is essential', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'InferenceContainer',
          Essential: true,
        }),
      ]),
    });
  });

  test('container exposes port 8000 over TCP', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          PortMappings: Match.arrayWith([
            Match.objectLike({
              ContainerPort: 8000,
              Protocol: 'tcp',
            }),
          ]),
        }),
      ]),
    });
  });

  /*
  test('container uses awslogs log driver with correct stream prefix', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          LogConfiguration: Match.objectLike({
            LogDriver: 'awslogs',
            Options: Match.objectLike({
              // CDK resolves the log group name as a Ref — use anyValue()
              'awslogs-group': Match.anyValue(),
              'awslogs-region': 'ap-southeast-2',
              'awslogs-stream-prefix': 'InferenceService',
            }),
          }),
        }),
      ]),
    });
  });
*/
  // ✅ KEY FIX: CDK emits HealthCheck.Command as a flat array
  //    ["CMD-SHELL", "curl -f http://localhost:8000/health || exit 1"]
  //    Interval/Timeout/StartPeriod are plain integers (seconds), NOT Duration objects
  test('health check has correct command, startPeriod=120, interval=30, timeout=10', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          HealthCheck: {
            Command: [
              'CMD-SHELL',
              'curl -f http://localhost:8000/health || exit 1',
            ],
            Interval: 30,
            Timeout: 10,
            StartPeriod: 120,
            Retries: 3,
          },
        }),
      ]),
    });
  });
});

// ================================================================
// 6. Network Load Balancer
// ================================================================
describe('Network Load Balancer', () => {
  test('creates exactly 1 load balancer', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('NLB is internet-facing and of type network', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'network',
    });
  });

  test('NLB listener is TCP on port 80', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'TCP',
    });
  });
});

// ================================================================
// 7. Target Group
// ================================================================
describe('Target Group', () => {
  test('target group is IP type on port 8000 TCP', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8000,
      Protocol: 'TCP',
      TargetType: 'ip',
    });
  });

  test('target group health check hits /health expecting HTTP 200', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckProtocol: 'HTTP',
      HealthCheckPath: '/health',
      HealthCheckPort: '8000',
      Matcher: { HttpCode: '200' },
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 10,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
    });
  });

  test('deregistration delay is 30 seconds', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetGroupAttributes: Match.arrayWith([
        Match.objectLike({
          Key: 'deregistration_delay.timeout_seconds',
          Value: '30',
        }),
      ]),
    });
  });
});

// ================================================================
// 8. Fargate Service
// ================================================================
describe('Fargate Service', () => {
  test('desired count is 1 on FARGATE launch type', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      LaunchType: 'FARGATE',
    });
  });

  test('health check grace period is 120 seconds', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      HealthCheckGracePeriodSeconds: 120,
    });
  });

  test('circuit breaker is enabled with rollback', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      }),
    });
  });

  test('tasks run in private subnets with no public IP', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'DISABLED',
        }),
      },
    });
  });

  test('deployment config has min 50% and max 200%', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 50,
        MaximumPercent: 200,
      }),
    });
  });
});

// ================================================================
// 9. CloudWatch Log Group
// ================================================================
describe('CloudWatch Log Group', () => {
  test('log group name is /ecs/inference-service with 30-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/inference-service',
      RetentionInDays: 30,
    });
  });
});

// ================================================================
// 10. Stack Outputs
// ================================================================
describe('Stack Outputs', () => {
  test('exports InferenceEndpointUrl', () => {
    template.hasOutput('InferenceEndpointUrl', {
      Export: { Name: 'InferenceEndpointUrl' },
    });
  });

  test('outputs EcsClusterName', () => {
    template.hasOutput('EcsClusterName', {});
  });

  test('outputs CloudWatchLogGroup', () => {
    template.hasOutput('CloudWatchLogGroup', {});
  });
});

// ================================================================
// 11. Resource Count Sanity Checks
// ================================================================
describe('Resource Count Sanity Checks', () => {
  test('zero API Gateway resources — this is an NLB architecture', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
  });

  test('exactly 1 ECS cluster', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('exactly 1 ECS task definition', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  });

  test('exactly 1 ECS service', () => {
    template.resourceCountIs('AWS::ECS::Service', 1);
  });

  test('exactly 1 NLB', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('exactly 1 target group', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  });

  test('exactly 1 NLB listener', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  });
});
