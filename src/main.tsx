import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'
import {AppProvider} from './state'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><AppProvider><App/></AppProvider></BrowserRouter></StrictMode>)
if('serviceWorker' in navigator)window.addEventListener('load',()=>void navigator.serviceWorker.register('/sw.js'))
