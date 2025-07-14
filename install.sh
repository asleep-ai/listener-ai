#!/bin/bash

# Fix Listener.AI installation issues on macOS
# This script removes quarantine attributes and bypasses Gatekeeper for the app

echo "🔧 Listener.AI Installation Fix Script"
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}❌ This script is only for macOS${NC}"
    exit 1
fi

# Function to fix DMG file
fix_dmg() {
    local dmg_path="$1"
    
    if [ ! -f "$dmg_path" ]; then
        echo -e "${RED}❌ DMG file not found: $dmg_path${NC}"
        return 1
    fi
    
    echo -e "${YELLOW}📦 Processing DMG: $(basename "$dmg_path")${NC}"
    
    # Remove quarantine attribute from DMG
    echo "  → Removing quarantine from DMG..."
    xattr -cr "$dmg_path"
    
    # Mount the DMG
    echo "  → Mounting DMG..."
    hdiutil attach "$dmg_path" -quiet
    
    # Find the mounted volume
    local volume_path=$(ls -d /Volumes/Listener.AI* 2>/dev/null | head -n 1)
    
    if [ -z "$volume_path" ]; then
        echo -e "${RED}❌ Failed to mount DMG${NC}"
        return 1
    fi
    
    echo -e "${GREEN}✓ DMG mounted at: $volume_path${NC}"
    
    # Copy app to Applications
    local app_path="$volume_path/Listener.AI.app"
    
    if [ -d "$app_path" ]; then
        echo "  → Copying app to Applications..."
        
        # Remove existing app if present
        if [ -d "/Applications/Listener.AI.app" ]; then
            rm -rf "/Applications/Listener.AI.app"
        fi
        
        # Copy the app
        cp -R "$app_path" /Applications/
        
        # Remove quarantine from the copied app
        echo "  → Removing quarantine from app..."
        xattr -cr /Applications/Listener.AI.app
        
        # Add to Gatekeeper exception
        echo "  → Adding app to Gatekeeper exceptions..."
        sudo spctl --add /Applications/Listener.AI.app
        sudo spctl --enable --label "Listener.AI.app"
        
        echo -e "${GREEN}✓ App installed successfully!${NC}"
    else
        echo -e "${RED}❌ App not found in DMG${NC}"
        hdiutil detach "$volume_path" -quiet
        return 1
    fi
    
    # Unmount the DMG
    echo "  → Unmounting DMG..."
    hdiutil detach "$volume_path" -quiet
    
    return 0
}

# Function to fix already installed app
fix_installed_app() {
    local app_path="/Applications/Listener.AI.app"
    
    if [ ! -d "$app_path" ]; then
        echo -e "${RED}❌ Listener.AI is not installed in Applications${NC}"
        return 1
    fi
    
    echo -e "${YELLOW}🔧 Fixing installed app...${NC}"
    
    # Remove quarantine
    echo "  → Removing quarantine attributes..."
    xattr -cr "$app_path"
    
    # Add to Gatekeeper exception
    echo "  → Adding to Gatekeeper exceptions..."
    sudo spctl --add "$app_path"
    sudo spctl --enable --label "Listener.AI.app"
    
    echo -e "${GREEN}✓ App fixed successfully!${NC}"
    return 0
}

# Main script
echo ""
echo "Choose an option:"
echo "1) Fix DMG file in Downloads folder"
echo "2) Fix already installed app in Applications"
echo "3) Both (recommended for fresh install)"
echo ""
read -p "Enter your choice (1-3): " choice

case $choice in
    1)
        # Find DMG in Downloads
        dmg_file=$(ls -t ~/Downloads/Listener.AI*.dmg 2>/dev/null | head -n 1)
        
        if [ -z "$dmg_file" ]; then
            echo -e "${RED}❌ No Listener.AI DMG found in Downloads folder${NC}"
            exit 1
        fi
        
        fix_dmg "$dmg_file"
        ;;
    2)
        fix_installed_app
        ;;
    3)
        # Find DMG in Downloads
        dmg_file=$(ls -t ~/Downloads/Listener.AI*.dmg 2>/dev/null | head -n 1)
        
        if [ -n "$dmg_file" ]; then
            fix_dmg "$dmg_file"
        else
            echo -e "${YELLOW}⚠️  No DMG found, trying to fix installed app...${NC}"
            fix_installed_app
        fi
        ;;
    *)
        echo -e "${RED}❌ Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✅ Done! You should now be able to run Listener.AI.${NC}"
echo ""
echo "If you still see issues:"
echo "1. Go to System Settings > Privacy & Security"
echo "2. Look for a message about Listener.AI being blocked"
echo "3. Click 'Open Anyway'"
echo ""
echo "Note: You may need to grant microphone permissions when first running the app."