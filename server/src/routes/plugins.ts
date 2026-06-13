/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins (soft delete or hard purge)
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 * - Discovering and executing plugin-contributed agent tools
 *
 * Most routes require board-level authentication, and sensitive instance-wide
 * mutations such as install/upgrade require instance-admin privileges.
 * Plugin tool discovery and execution routes allow both board and agent access.
 *
 * @module server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */