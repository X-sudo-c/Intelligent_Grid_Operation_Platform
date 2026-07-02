import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

try {
  const saved = localStorage.getItem('giop.portal.theme.v1')
  const isLight = saved === 'light'
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark'
  document.documentElement.classList.toggle('dark', !isLight)
} catch {
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.classList.add('dark')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
