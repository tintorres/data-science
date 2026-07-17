import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import joblib
from pathlib import Path
import logging
import sys

# local
channel_path = f"{Path.cwd()}"

# uncomment next line when run in aws sagemaker
#channel_path = '/opt/ml'

data_channel_path = f"{channel_path}/input/data/train"
model_channel_path = f"{channel_path}/model"
output_channel_path = f"{channel_path}/output"

def setup_logger( logger_id ):
    logger = logging.getLogger("model_testing")
    logger.setLevel(logging.INFO)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        formatter = logging.Formatter(
            f"%(asctime)s - {logger_id} - %(levelname)s - %(message)s",
            "%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    return logger

logger = setup_logger( "model_testing_execution" )


def test_item(model_fqdn, train_csv_file, y_field, features, test_csv_file):

    train_csv_file_path = f"{data_channel_path}/{train_csv_file}"
    training_data = pd.read_csv(train_csv_file_path)
    y = training_data[y_field]

    test_csv_file_path = f"{data_channel_path}/{test_csv_file}"
    test_data = pd.read_csv(test_csv_file_path)
    test_X = test_data[features]
    joblib_file_path = f"{model_channel_path}/{model_fqdn}"

    model = joblib.load(joblib_file_path)
    test_preds = model.predict(test_X)
    mae = mean_absolute_error(y, test_preds)
    mse = mean_squared_error(y, test_preds)
    rmse = mse ** 0.5
    r2 = r2_score(y, test_preds)
    logger.info(f"MAE={mae}, MSE={mse}, RMSE={rmse}, R2={r2}")


def test():

    # house prices
    train_csv_file = 'house_prices_train.csv'
    y_field = 'SalePrice'
    features = ['LotArea', 'YearBuilt', '1stFlrSF', '2ndFlrSF',
                'FullBath', 'BedroomAbvGr', 'TotRmsAbvGrd']
    test_csv_file = 'house_prices_test.csv'

    model_fqdn = 'sklearn.tree.DecisionTreeRegressor'
    test_item(model_fqdn, train_csv_file, y_field, features, test_csv_file)
    model_fqdn = 'sklearn.ensemble.RandomForestRegressor'
    test_item(model_fqdn, train_csv_file, y_field, features, test_csv_file)


if __name__ == "__main__":
    
    test()