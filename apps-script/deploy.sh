#!/bin/bash
# Pushes the backend and updates the existing web-app deployment (same URL).
set -e
cd "$(dirname "$0")"
DEPLOYMENT_ID="AKfycbzGWAazTIj5hS3-Oq9wsoreG5LhUprn9GQGGLgIcIbkF0zbjdhZ9eeDr6dKLLACt4qoWg"
clasp push --force
clasp update-deployment "$DEPLOYMENT_ID" --description "update $(date +%F)"
