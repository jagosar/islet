/** The D-Bus contract between the daemon, the extension and the Claude Code bridges. */

export const BUS_NAME = 'io.github.jagosar.Islet';
export const OBJECT_PATH = '/io/github/jagosar/Islet';
export const INTERFACE_NAME = 'io.github.jagosar.Islet1';

export const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE_NAME}">
    <method name="ReportAgentEvent">
      <arg type="a{ss}" name="fields" direction="in"/>
    </method>
    <signal name="AgentEvent">
      <arg type="a{ss}" name="fields"/>
    </signal>
  </interface>
</node>`;
