# inference.py
import joblib
from fastapi import FastAPI
import numpy as np
from prometheus_fastapi_instrumentator import Instrumentator

app = FastAPI()
model = joblib.load("model.joblib")
Instrumentator().instrument(app).expose(app)

@app.get("/")
def read_root():
    return {"message": "Welcome to the Inference API"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/predict")
def predict(payload: dict):
    X = np.array(payload["input"]).reshape(1, -1)
    y = model.predict(X)
    return {"prediction": float(y[0])}
