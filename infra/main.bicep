@description('Base name for resources.')
param app_name string

@description('''
either https://[app_name].azurewebsites.net or https://[custom_domain]''')
param base_url string

@description('''
The application id of the Entra App registration that will represent the
mcp server.

Tokens must end up with this value as the Audience/`aud` in order to be valid
''')
param client_id string

@description('''
Name of scope to be validated by the app, without the resource prefix.
If the full scope name was `api://[client_id]/user_impersonation` then the value
of this parameter should just be 'user_impersonation'
''')
param required_scope string

@description('''
Application ID URI like `api://[client_id]` or if configured to reflect custom
domain then `https://[mycustomdomain]`
''')
param application_id_uri string

@description('''The list of client_id's that will be''')
param allowed_client_ids string[]


resource keyv 'Microsoft.KeyVault/vaults@2026-02-01' = {
  name:'${app_name}-kv'
  location: resourceGroup().location
  properties: {
    sku: {
      name: 'standard'
      family: 'A'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization:true
  }
}

// Grant the app's managed identity access to read secrets — RBAC model
resource kvSecretUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyv.id, site.id, 'KeyVaultSecretsUser')
  scope: keyv
  properties: {
    principalId: site.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
    )
    principalType: 'ServicePrincipal'
  }
}


resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${app_name}-plan'
  location: resourceGroup().location
  sku: { name: 'B1', tier: 'Basic' }
  kind: 'linux'
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2025-03-01' = {
  name: app_name
  location: resourceGroup().location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { 
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true' 
        }
        { 
          name:'AZURE_TENANT_ID'
          value: subscription().tenantId 
        }
        { 
          name:'AZURE_CLIENT_ID'
          value: client_id 
        }
        { 
          name:'ALLOWED_CLIENT_IDS'
          value: join(allowed_client_ids, ';') 
        }
        { 
          name:'REQUIRED_SCOPE'
          value: required_scope 
        }
        {
          name: 'APPLICATION_ID_URI'
          value: application_id_uri
        }
        { 
          name:'BASE_URL'
          value: base_url 
        }
        { name: 'NEO4J_AUTH', value: '@Microsoft.KeyVault(SecretUri=${keyv.properties.vaultUri}secrets/neo4j-auth/)'}
        { name: 'NEO4J_HOST', value: '@Microsoft.KeyVault(SecretUri=${keyv.properties.vaultUri}secrets/neo4j-host/)'}
        { name: 'NEO4J_URL', value: '@Microsoft.KeyVault(SecretUri=${keyv.properties.vaultUri}secrets/neo4j-url/)'}
      ]
    }
  }
}
