# inference.py
import joblib
from fastapi import FastAPI
import numpy as np

app = FastAPI()
model = joblib.load("model.joblib")

@app.post("/predict")
def predict(payload: dict):
    X = np.array(payload["input"]).reshape(1, -1)
    y = model.predict(X)
    return {"prediction": float(y[0])}
