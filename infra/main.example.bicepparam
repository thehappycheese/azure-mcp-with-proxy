using 'main.bicep'

param app_name = readEnvironmentVariable('AZURE_DEFAULTS_WEB')
param base_url = readEnvironmentVariable('BASE_URL')
param required_scope = readEnvironmentVariable('REQUIRED_SCOPE')
param application_id_uri = readEnvironmentVariable('APPLICATION_ID_URI')
param client_id = readEnvironmentVariable('AZURE_CLIENT_ID')
param allowed_client_ids = distinct([
  'aebc6443-996d-45c2-90f0-388ff96faa56' // vscode (Global/Well-known Microsoft App ID)
  '04b07795-8ddb-461a-bbee-02f9e1bf7b46' // azure cli (Global/Well-known Microsoft App ID)
  // Entra App ID representing external clients like https://claude.au's custom connector,
  ...filter(split(readEnvironmentVariable('ALLOWED_CLIENT_IDS',''),';'),i=>i!='')
])
