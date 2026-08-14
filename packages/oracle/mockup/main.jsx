import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import EntitiesAndPatterns from './oracle.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <EntitiesAndPatterns />
  </StrictMode>
)
