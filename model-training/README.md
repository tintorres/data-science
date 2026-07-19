# data-science
Data Science Exercises

## Installation
* `Python` brew install python3.10
* `venv` python3 venv venv
* `activate` source venv/bin/activate

## AWS Sagemaker
* `Sagemaker aws on python3.12` pip install "sagemaker==2.197.0" --force-reinstall
* `Sagemaker local` pip install sagemaker
* `Dependecies` pip install boto3 botocore numpy pandas scikit-learn joblib
* `get_execution_role()` AmazonSageMaker-ExecutionPolicy-20260703T120261
* `install docker` brew install --cask docker
* `ipykernel` pip install ipykernel

## inference api
* `install fast api` pip install fastapi
* `install uvicorn` pip install "uvicorn[standard]"
* `build docker image` docker build -t inference-endpoint-docker -f DockerFile .
* `run docker` docker run -p 8000:8000 inference-endpoint-docker 
* `test` curl -X POST -H "Content-Type: application/json" -d @request.json http://localhost:8000/predict
* `check container` docker exec -it [container] /bin/sh
* `check logs` docker logs [container]
* `stop docker` docker stop $(docker ps -1)