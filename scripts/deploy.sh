!/bin/bash
# Build and deploy script for YouTube Transcript LLM Obsidian plugin

set -e  # Exit on any error

# Configuration
PLUGIN_ID="tubesage"
SOURCE_DIR="/Users/rmccorkl/Code/ObsidianPlugin"
TARGET_DIR="/Users/rmccorkl/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/MainVault/.obsidian/plugins/$PLUGIN_ID"

# Get version from manifest.json
VERSION=$(grep -o '"version": "[^"]*"' "$SOURCE_DIR/manifest.json" | cut -d'"' -f4)
ZIP_FILENAME="${PLUGIN_ID}-${VERSION}.zip"
TEMP_DIR="/tmp/${PLUGIN_ID}-packaging"

echo "===== YouTube Transcript LLM Plugin Deployment ====="
echo "Source: $SOURCE_DIR"
echo "Target: $TARGET_DIR"
echo "Version: $VERSION"

# Step 1: Run the build in the source directory
echo -e "\n1. Building plugin..."
cd "$SOURCE_DIR"

# Check if we have a working npm via homebrew
if [ -x "/opt/homebrew/bin/npm" ]; then
    echo "Using Homebrew npm for build..."
    PATH="/opt/homebrew/bin:$PATH" npm run build
elif [ -x "$(command -v npm)" ]; then
    echo "Using system npm for build..."
    npm run build
else
    echo "ERROR: npm not found, skipping build step"
    echo "You'll need to build the plugin manually before deploying"
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
cp "$SOURCE_DIR/manifest.json" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/MIT-license-tubesage.md" "$TEMP_DIR/$PLUGIN_ID/"
cp "$SOURCE_DIR/README.md" "$TEMP_DIR/$PLUGIN_ID/"

# Copy templates directory
echo "Copying templates..."
mkdir -p "$TEMP_DIR/$PLUGIN_ID/templates"
cp -r "$SOURCE_DIR/templates" "$TEMP_DIR/$PLUGIN_ID/"

# Note: We're not copying the src directory for distribution
# since all necessary code is bundled in main.js

# Create ZIP file with correct structure
cd "$TEMP_DIR"
echo "Creating ZIP file with the following structure:"
find "$PLUGIN_ID" -type f | sort

echo "Packaging ZIP file..."
zip -r "$SOURCE_DIR/$ZIP_FILENAME" "$PLUGIN_ID"
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

# Clean up temp directory
rm -rf "$TEMP_DIR"

# Step 3: Ensure the target directories exist for local deployment
echo -e "\n3. Preparing target directory structure for local deployment..."
mkdir -p "$TARGET_DIR"

# Step 4: Copy the compiled plugin files for local testing
echo -e "\n4. Copying plugin files to local Obsidian vault for testing..."
cp -r "$SOURCE_DIR/main.js" "$SOURCE_DIR/manifest.json" "$TARGET_DIR/"
cp -r "$SOURCE_DIR/MIT-license-tubesage.md" "$TARGET_DIR/"
cp -r "$SOURCE_DIR/README.md" "$TARGET_DIR/"

# Copy template directory
mkdir -p "$TARGET_DIR/templates"
cp -r "$SOURCE_DIR/templates/YouTubeTranscript.md" "$TARGET_DIR/templates/"

echo "Copied main.js, manifest.json, MIT-license-tubesage.md, README.md, and templates/"

# Step 6: Verify the deployment
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

echo -e "\n===== Deployment Complete ====="
echo "ZIP File: $SOURCE_DIR/$ZIP_FILENAME" 
echo "Local: Reload Obsidian to apply changes" 