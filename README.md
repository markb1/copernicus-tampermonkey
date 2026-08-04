# copernicus-tampermonkey

This is a tampermonkey script to fix the frequent logout problem with Copernicus Browser.
It uses OAuth credentials that you generate with your Copernicus account to authorize requests to the server. It will automatically log you into Copernicus Browser as long as your OAuth credentials have not expired.

## Prereqs

1. A Copernicus account
2. Tampermonkey extension installed in the web browser that you are going to use with Copernicus Browser

# Setup

1. Open Tampermonkey dashboard, and create new script
2. Copy tampermonkey-cdse-auth.user.js into the new Tampermonkey script
3. Go to https://shapps.dataspace.copernicus.eu/dashboard/#/account/settings (login if not already)
4. Create a new OAuth client.
5. Choose an expiration or "Never expire"
6. Click Create
7. The new Client ID and Client Secret will be displayed. Copy those in to the Tampermonkey script where is says "FILL_ME_IN".
8. Go to Copernicus Browser and enjoy automatic login!
