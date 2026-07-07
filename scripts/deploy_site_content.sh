cd server
mkdir dist
zip ./dist/dist.zip server.ts server_logging_utils.ts package.json package-lock.json tsconfig.json startup.sh
cd ..
az webapp deploy \
    --type zip \
    --src-path server/dist/dist.zip
