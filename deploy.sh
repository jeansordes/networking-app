#!/bin/bash

# build the app in app/dist
cd app
npm run build
cd ..

# check the .env file
if [ ! -f .env ]; then
    echo "Error: .env file not found"
    exit 1
fi

# read the .env file
source .env

# check if $REMOTE_HOST is set
if [ -z "$REMOTE_HOST" ]; then
    echo "Error: REMOTE_HOST is not set (it should look like 'username@192.168.1.1')"
    exit 1
fi

# check if $REMOTE_DIR is set
if [ -z "$REMOTE_DIR" ]; then
    echo "Error: REMOTE_DIR is not set (it should look like '/home/username/htdocs/')"
    exit 1
fi

# rsync the dist directory to the remote host
rsync -avz --delete ./app/dist/ $REMOTE_HOST:$REMOTE_DIR