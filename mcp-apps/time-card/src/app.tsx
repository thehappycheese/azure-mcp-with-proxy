import { useCallback, useEffect, useState } from 'preact/hooks';
import { App as McpApp } from "@modelcontextprotocol/ext-apps";

const app = new McpApp({
  name: "Get Time App",
  version: "1.0.0"
});
app.connect();

export function App() {
  const [count, set_count] = useState("...");

  const on_click = useCallback(async () => {
    const result = await app.callServerTool({
      name: "get-time",
      arguments: {},
    });
    const time = result.content?.find((c) => c.type === "text")?.text;
    set_count(time ?? "[ERROR]");
  },[]);

  useEffect(()=>{
    app.ontoolresult = (result) => {
      const time = result.content?.find((c) => c.type === "text")?.text;
      set_count(time ?? "[ERROR]");
    };
  },[]);

  return (
    <div>
      <button onClick={on_click}>Message: {count}</button>
    </div>
  )
}
