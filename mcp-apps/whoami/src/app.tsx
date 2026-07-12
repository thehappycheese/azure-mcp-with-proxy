import { useState } from 'preact/hooks'



export function App() {
  const [count, setCount] = useState(0)

  return (
    <div>
      poggers!
      <button onClick={()=>setCount(count+1)}>Count: {count}</button>
    </div>
  )
}
