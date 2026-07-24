# cp ./mcp-apps/whoami/dist/index.html ./server/whoami.html
zip -j \
    ./server/dist.zip \
    ./server/server.ts \
    ./server/server_logging_utils.ts \
    ./server/package.json \
    ./server/package-lock.json \
    ./server/tsconfig.json \
    ./server/time.html
az webapp deploy \
    --type zip \
    --src-path server/dist.zip
