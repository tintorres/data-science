import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { InferenceEndpointCdk } from "../lib/inference-endpoint-cdk-stack";

describe("InferenceEndpointCdk", () => {
  test("synthesizes ECS, NLB, API Gateway, and VPC Link", () => {
    const app = new cdk.App();
    const stack = new InferenceEndpointCdk(app, "TestInferenceStack");

    const template = Template.fromStack(stack);

    // VPC
    template.hasResourceProperties("AWS::EC2::VPC", {
      CidrBlock: Match.anyValue(),
    });

    // ECS Cluster
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: Match.anyValue(),
    });

    // Fargate Service
    template.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
    });

    // NLB
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Type: "network",
    });

    // API Gateway RestApi
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Name: "JoblibInferenceApi",
    });

    // VPC Link
    template.hasResourceProperties("AWS::ApiGateway::VpcLink", {
      Name: "InferenceVpcLink",
    });

    // /predict POST method
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: Match.anyValue(),
      AuthorizationType: "NONE",
    });
  });
});
