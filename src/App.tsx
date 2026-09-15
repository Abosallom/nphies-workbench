import { ToastProvider } from "./ui";
import { Shell } from "./views/Shell";

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
