#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="chat-ui"
REPO_URL="https://github.com/webprismdevin/paperclip-plugin-chat.git"

usage() {
  echo "Usage: $0 [install|uninstall] /path/to/paperclip"
  echo ""
  echo "  install    Clone plugin into paperclip/plugins/$PLUGIN_NAME"
  echo "  uninstall  Remove plugin directory (DB tables are left intact)"
  echo ""
  echo "Examples:"
  echo "  curl -sL <raw-url> | bash -s install /path/to/paperclip"
  echo "  ./install.sh install /path/to/paperclip"
  echo "  ./install.sh uninstall /path/to/paperclip"
  exit 1
}

if [ $# -lt 2 ]; then
  usage
fi

ACTION="$1"
PAPERCLIP_DIR="$2"

# Validate paperclip directory
if [ ! -d "$PAPERCLIP_DIR" ]; then
  echo "Error: $PAPERCLIP_DIR does not exist"
  exit 1
fi

if [ ! -d "$PAPERCLIP_DIR/server" ]; then
  echo "Error: $PAPERCLIP_DIR doesn't look like a Paperclip repo (no server/ directory)"
  exit 1
fi

PLUGINS_DIR="$PAPERCLIP_DIR/plugins"
INSTALL_DIR="$PLUGINS_DIR/$PLUGIN_NAME"

case "$ACTION" in
  install)
    # Ensure plugins/ directory exists
    mkdir -p "$PLUGINS_DIR"

    if [ -d "$INSTALL_DIR" ]; then
      echo "Plugin already installed at $INSTALL_DIR"
      echo "To update, run: cd $INSTALL_DIR && git pull"
      exit 0
    fi

    echo "Installing $PLUGIN_NAME into $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"

    echo ""
    echo "Installed successfully."
    echo ""
    echo "  Location: $INSTALL_DIR"
    echo "  Migrations will run automatically on next server start."
    echo ""
    echo "  To uninstall:"
    echo "    $0 uninstall $PAPERCLIP_DIR"
    ;;

  uninstall)
    if [ ! -d "$INSTALL_DIR" ]; then
      echo "Plugin not found at $INSTALL_DIR — nothing to remove."
      exit 0
    fi

    echo "Removing $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"

    echo ""
    echo "Plugin files removed."
    echo ""
    echo "  Note: Database tables (plugin_chat_ui_threads, plugin_chat_ui_messages)"
    echo "  were NOT dropped. To remove data, run against your DB:"
    echo ""
    echo "    DROP TABLE IF EXISTS plugin_chat_ui_messages CASCADE;"
    echo "    DROP TABLE IF EXISTS plugin_chat_ui_threads CASCADE;"
    echo "    DELETE FROM plugin_migrations WHERE plugin_name = '$PLUGIN_NAME';"
    ;;

  *)
    usage
    ;;
esac
