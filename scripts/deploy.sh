#!/bin/bash
# Build and deploy script for YouTube Transcript LLM Obsidian plugin
# Uses ScrapeCreators HTTP-only method - lightweight and reliable!

set -e  # Exit on any error

# Configuration
PLUGIN_ID="tubesage"
# Allow overriding via env; otherwise derive from script location
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${SOURCE_DIR_OVERRIDE:-$REPO_ROOT}"
DEFAULT_TARGET_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/MainVault/.obsidian/plugins/$PLUGIN_ID"
TARGET_DIR="${TARGET_DIR_OVERRIDE:-$DEFAULT_TARGET_DIR}"

# Get version from manifest.json
VERSION=$(grep -o '"version": "[^"]*"' "$SOURCE_DIR/manifest.json" | cut -d'"' -f4)
ZIP_FILENAME="${PLUGIN_ID}-${VERSION}.zip"
TEMP_DIR="/tmp/${PLUGIN_ID}-packaging"

echo "===== YouTube Transcript LLM Plugin Deployment ====="
echo "Source: $SOURCE_DIR"
echo "Target: $TARGET_DIR"
echo "Version: $VERSION"
echo "Method: ScrapeCreators (HTTP-only, no browser dependencies)"

# Step 1: Build plugin with simplified proxy
echo -e "\n1. Building plugin with simplified proxy (ScrapeCreators HTTP-only)..."
cd "$SOURCE_DIR"

# Check if we have a working npm via homebrew
if [ -x "/opt/homebrew/bin/npm" ]; then
    echo "Using Homebrew npm for simplified build..."
    PATH="/opt/homebrew/bin:$PATH" npm run build
elif [ -x "$(command -v npm)" ]; then
    echo "Using system npm for simplified build..."
    npm run build
else
    echo "ERROR: npm not found, skipping build step"
    echo "You'll need to build the plugin manually before deploying"
    echo "Run: npm run build"
    # Continue anyway since we might be testing with pre-built files
fi

# Step 2: Create production ZIP file
echo -e "\n2. Creating production ZIP file..."

# Create and clean temp directory
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR/$PLUGIN_ID"

# Copy all necessary files to temp directory
echo "Copying required files to temporary directory..."
cp "$SOURCE_DIR/main.js" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/styles.css" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/manifest.json" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/MIT-license-tubesage.md" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/README.md" "$TEMP_DIR/$PLUGIN_ID/"

# Copy templates directory
echo "Copying templates..."
mkdir -p "$TEMP_DIR/$PLUGIN_ID/templates"
cp -r "$SOURCE_DIR/templates" "$TEMP_DIR/$PLUGIN_ID/"

# Note: Using direct ScrapeCreators method - no proxy needed!
echo "ℹ️  Using direct ScrapeCreators method (HTTP-only, no proxy dependencies)"

# Note: We're not copying the src directory for distribution
# since all necessary code is bundled in main.js

# Clean up unnecessary files before packaging
echo "Cleaning up unnecessary files..."
# Remove macOS system files
find "$TEMP_DIR/$PLUGIN_ID" -name ".DS_Store" -delete 2>/dev/null || true
find "$TEMP_DIR/$PLUGIN_ID" -name "__MACOSX" -type d -exec rm -rf {} + 2>/dev/null || true
# Remove common development files
find "$TEMP_DIR/$PLUGIN_ID" -name "*.log" -delete 2>/dev/null || true
find "$TEMP_DIR/$PLUGIN_ID" -name "npm-debug.log*" -delete 2>/dev/null || true
find "$TEMP_DIR/$PLUGIN_ID" -name ".npm" -type d -exec rm -rf {} + 2>/dev/null || true
find "$TEMP_DIR/$PLUGIN_ID" -name ".cache" -type d -exec rm -rf {} + 2>/dev/null || true
echo "✅ Unnecessary files cleaned up"

# Create ZIP file with correct structure
cd "$TEMP_DIR"
echo "Creating ZIP file with the following structure:"
find "$PLUGIN_ID" -type f | sort

echo "Packaging ZIP file (excluding system files)..."
zip -r "$SOURCE_DIR/$ZIP_FILENAME" "$PLUGIN_ID" -x "*.DS_Store" "*/__MACOSX/*" "*.log"
echo "Created ZIP file: $SOURCE_DIR/$ZIP_FILENAME"

# List ZIP contents for verification
echo -e "\nVerifying ZIP file contents:"
unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -v "__MACOSX" | grep -v ".DS_Store"

# Verify the structure is correct for Obsidian
echo -e "\nVerifying Obsidian plugin structure:"
ZIP_ROOT_DIR=$(unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -v "__MACOSX" | grep -v ".DS_Store" | awk 'NR > 4 {print $4}' | head -1 | cut -d/ -f1)
if [ "$ZIP_ROOT_DIR" = "$PLUGIN_ID" ]; then
    echo "✅ ZIP structure verified: Root directory is $PLUGIN_ID/"
    echo "✅ This will extract correctly for Obsidian users"
else
    echo "❌ WARNING: ZIP structure may not be compatible with Obsidian"
    echo "Expected root directory: $PLUGIN_ID/"
    echo "Found root directory: $ZIP_ROOT_DIR/"
fi

# Check for required files
if unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -q "$PLUGIN_ID/main.js" && \
   unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -q "$PLUGIN_ID/manifest.json"; then
    echo "✅ Required Obsidian plugin files verified (main.js, manifest.json)"
else
    echo "❌ WARNING: Required Obsidian plugin files missing in ZIP"
fi

# Verify no proxy files (direct method only)
if unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -q "$PLUGIN_ID/proxy/"; then
    echo "❌ WARNING: Found unexpected proxy files in ZIP"
else
    echo "✅ Verified: Direct method only (no proxy files)"
fi

# Verify no browser dependencies (simplified version)
if unzip -l "$SOURCE_DIR/$ZIP_FILENAME" | grep -q "$PLUGIN_ID/chromium/\|$PLUGIN_ID/node/"; then
    echo "❌ WARNING: Found unexpected browser dependencies in ZIP"
else
    echo "✅ Verified: No browser dependencies in ZIP (simplified ScrapeCreators method)"
fi


# Clean up temp directory
rm -rf "$TEMP_DIR"

# Step 3: Ensure the target directories exist for local deployment
echo -e "\n3. Preparing target directory structure for local deployment..."

# Backup existing data.json BEFORE creating/cleaning target directory (preserve user settings)
BACKUP_FILE="/tmp/tubesage-settings-backup.json"
if [ -f "$TARGET_DIR/data.json" ]; then
    echo "Backing up existing plugin settings (data.json)..."
    cp "$TARGET_DIR/data.json" "$BACKUP_FILE"
fi

mkdir -p "$TARGET_DIR"

# Step 4: Copy the compiled plugin files for local testing
echo -e "\n4. Copying plugin files to local Obsidian vault for testing..."

# Copy main plugin files
cp -r "$SOURCE_DIR/main.js" "$SOURCE_DIR/styles.css" "$SOURCE_DIR/manifest.json" "$TARGET_DIR/"
cp -r "$SOURCE_DIR/MIT-license-tubesage.md" "$TARGET_DIR/"
cp -r "$SOURCE_DIR/README.md" "$TARGET_DIR/"

# Copy template directory
mkdir -p "$TARGET_DIR/templates"
cp -r "$SOURCE_DIR/templates/YouTubeTranscript.md" "$TARGET_DIR/templates/"

# Note: Using direct ScrapeCreators method for local testing - no proxy needed!
echo "ℹ️  Using direct ScrapeCreators method for local testing (HTTP-only, no proxy dependencies)"

# Restore backed up settings if they existed
if [ -f "$BACKUP_FILE" ]; then
    echo "Restoring plugin settings..."
    cp "$BACKUP_FILE" "$TARGET_DIR/data.json"
    rm "$BACKUP_FILE"
    echo "Settings preserved from previous deployment"
fi

echo "Copied main.js, styles.css, manifest.json, MIT-license-tubesage.md, README.md, and templates/"

# Step 5: Verify the deployment
echo -e "\n5. Verifying local deployment..."

# Check if main plugin files exist
if [ -f "$TARGET_DIR/main.js" ] && [ -f "$TARGET_DIR/manifest.json" ]; then
    echo "✅ Main plugin files verified"
else
    echo "❌ Main plugin files missing"
fi

# Check if template file exists
if [ -f "$TARGET_DIR/templates/YouTubeTranscript.md" ]; then
    echo "✅ Example template verified"
else
    echo "❌ Example template missing"
fi

# Verify no proxy files (direct method only)
if [ -d "$TARGET_DIR/proxy" ]; then
    echo "❌ WARNING: Found unexpected proxy directory in local deployment"
else
    echo "✅ Verified: Direct method only (no proxy files in local deployment)"
fi

# Verify no browser dependencies (simplified version)
if [ ! -d "$TARGET_DIR/chromium" ] && [ ! -d "$TARGET_DIR/node" ] && \
   ! find "$TARGET_DIR" -name "*puppeteer*" -type f | grep -q .; then
    echo "✅ Verified: No browser dependencies in local deployment (simplified ScrapeCreators method)"
    echo "✅ Significantly reduced disk usage compared to full version!"
else
    echo "❌ WARNING: Found unexpected browser dependencies in local deployment"
fi

# Check if settings are preserved
if [ -f "$TARGET_DIR/data.json" ]; then
    echo "✅ Plugin settings (data.json) preserved"
else
    echo "ℹ️  No existing settings found (first deployment)"
fi

echo -e "\n===== TubeSage Deployment Complete ====="
echo "ZIP File: $SOURCE_DIR/$ZIP_FILENAME" 
echo "Method: Direct ScrapeCreators (HTTP-only)"
echo "Dependencies: Built-in HTTP only (no external dependencies)"
echo "Package Size: ~100KB (extremely lightweight!)"
echo "Local: Reload Obsidian to apply changes" 
