import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import joblib
from pathlib import Path
import importlib

#local 
channel_path = f"{Path.cwd()}"
data_channel_path = f"{channel_path}/input/data/train"
model_channel_path = f"{channel_path}/model/joblib"

#sagemaker
#channel_path = '/opt/ml'

def class_load(model_fqdn:str):
    module_name, class_name = model_fqdn.rsplit(".", 1)
    module = importlib.import_module(module_name)
    return getattr(module, class_name)


def train_item(model_fqdn, train_csv_file, y_field, features ):        
    train_csv_file_path = f"{data_channel_path}/{train_csv_file}"
    training_data = pd.read_csv(train_csv_file_path)        
    y = training_data[y_field]
    X = training_data[features]
    
    # RandomForestRegressor
    Clazz = class_load(model_fqdn)
    model = Clazz()    
    model.fit(X, y)
    joblib_file = f"{model_channel_path}/{model_fqdn}"
    joblib.dump(model, joblib_file)
    print(f"Model dumped in {joblib_file}")    
    return model

    
def test_item( model_fqdn, train_csv_file, y_field, features, test_csv_file ):    

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
    print(f"MAE={mae}, MSE={mse}, RMSE={rmse}, R2={r2}")    

def train():

    #titanic
    model_fqdn = 'sklearn.ensemble.RandomForestRegressor'
    train_csv_file = 'titanic_train.csv'
    y_field = 'Survived'
    features = ["Pclass", "Sex", "SibSp", "Parch"]
    test_csv_file = 'titanic_test.csv'
    #train(model_fqdn, train_csv_file, y_field, features)
    #test( model_fqdn, train_csv_file, y_field, features, test_csv_file)

    #house prices
    train_csv_file = 'house_prices_train.csv'
    y_field = 'SalePrice'
    features = ['LotArea', 'YearBuilt', '1stFlrSF', '2ndFlrSF',
                    'FullBath', 'BedroomAbvGr', 'TotRmsAbvGrd']
    test_csv_file = 'house_prices_test.csv'


    model_fqdn = 'sklearn.tree.DecisionTreeRegressor'
    train_item(model_fqdn, train_csv_file, y_field, features)
    model_fqdn = 'sklearn.ensemble.RandomForestRegressor'
    train_item(model_fqdn, train_csv_file, y_field, features)

def test():

    #house prices
    train_csv_file = 'house_prices_train.csv'
    y_field = 'SalePrice'
    features = ['LotArea', 'YearBuilt', '1stFlrSF', '2ndFlrSF',
                    'FullBath', 'BedroomAbvGr', 'TotRmsAbvGrd']
    test_csv_file = 'house_prices_test.csv'

    model_fqdn = 'sklearn.tree.DecisionTreeRegressor'
    test_item( model_fqdn, train_csv_file, y_field, features, test_csv_file)
    model_fqdn = 'sklearn.ensemble.RandomForestRegressor'
    test_item( model_fqdn, train_csv_file, y_field, features, test_csv_file)

            
if __name__ == "__main__":

    #train()
    test()