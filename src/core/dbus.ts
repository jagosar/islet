// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The D-Bus contract between the daemon, the extension and the Claude Code bridges.
 *
 * Properties are JSON documents defined and validated in protocol.ts. Methods take flat
 * dictionaries so the bridges can call them without knowing the documents.
 */

export const BUS_NAME = 'io.github.jagosar.Islet';
export const OBJECT_PATH = '/io/github/jagosar/Islet';
export const INTERFACE_NAME = 'io.github.jagosar.Islet1';

/** Upper bound on entries in a method's dictionary argument. */
export const MAX_METHOD_FIELDS = 16;

export const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE_NAME}">
    <!-- Today's usage per model and fresh tokens per day (UsageSnapshot). -->
    <property name="Usage" type="s" access="read"/>
    <!-- Claude plan windows and when they were measured (PlanUsage), or null. -->
    <property name="PlanUsage" type="s" access="read"/>
    <!-- Current Claude Code sessions (AgentSession[]). -->
    <property name="Sessions" type="s" access="read"/>

    <!-- From the hook bridge: session_id, cwd, hook_event_name, notification_type. -->
    <method name="ReportAgentEvent">
      <arg type="a{ss}" name="fields" direction="in"/>
    </method>
    <!-- From the status line bridge: {five_hour,seven_day}_{used_percentage,resets_at}. -->
    <method name="ReportPlanUsage">
      <arg type="a{sd}" name="fields" direction="in"/>
    </method>

    <signal name="AgentEvent">
      <arg type="a{ss}" name="fields"/>
    </signal>
  </interface>
</node>`;
