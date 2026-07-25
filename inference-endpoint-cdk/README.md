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
* `restart docker desktop` osascript -e 'quit app "Docker"' && sleep 3 && open -a Docker

## AWS Deployment
* `Update IAM role` aws iam attach-role-policy \
    --role-name InferenceEndpointCdk-InferenceServiceTaskDefExecuti-R6y7YHEawXIW \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
