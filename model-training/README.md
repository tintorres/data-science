# Model Training
Model Training and Unit testing

## Installation - AWS Sagemaker
* `Sagemaker aws on python3.12` pip install "sagemaker==2.197.0" --force-reinstall
* `Sagemaker local` pip install sagemaker
* `Dependecies` pip install boto3 botocore numpy pandas scikit-learn joblib
* `get_execution_role()` AmazonSageMaker-ExecutionPolicy-20260703T120261
* `install docker` brew install --cask docker
* `ipykernel` pip install ipykernel

## inference api
* `install fast api` pip install fastapi
* `install uvicorn` pip install "uvicorn[standard]"
* `build docker image` docker --config /tmp/docker_isolated build -t inference-endpoint-docker -f DockerFile .
* `run docker` docker --config /tmp/docker_isolated run -p 8000:8000 inference-endpoint-docker 
* `test` curl -X POST -H "Content-Type: application/json" -d @request.json http://localhost:8000/predict \
curl -i http://localhost:8000 \
curl -i http://localhost:8000/health \
curl -X POST https://d31shfqvmdoxrq.cloudfront.net/predict \
  -H "Content-Type: text/csv" \
  --data-binary @<(curl -s https://raw.githubusercontent.com/tintorres/data-science/refs/heads/main/model-training/input/data/train/request.json)

* `check container` docker exec -it [container] /bin/sh
* `tag` docker --config /tmp/docker_isolated tag inference-endpoint-docker:latest \
046576049723.dkr.ecr.ap-southeast-2.amazonaws.com/joblib.inference:latest
* `check image has curl` docker run --rm inference-endpoint-docker:latest curl --version
* `check logs` docker logs [container]
* `stop docker` docker stop $(docker ps -1)
* `list image` docker image ls