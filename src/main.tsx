import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'
import {AppProvider} from './state'
import App from './App'
import './styles.css'
import {runtimeEnvironment} from './config'
import{clearDevelopmentServiceWorkers,registerProductionServiceWorker}from'./pwa'

const root=createRoot(document.getElementById('root')!)
root.render(runtimeEnvironment.valid?<StrictMode><BrowserRouter><AppProvider><App/></AppProvider></BrowserRouter></StrictMode>:<main className="configuration-error" role="alert"><h1>Ilova sozlanmagan</h1><p>Administrator production muhit sozlamalarini tekshirishi kerak.</p><ul>{runtimeEnvironment.issues.map(issue=><li key={issue.variable}><code>{issue.variable}</code>: {issue.message}</li>)}</ul></main>)
if(import.meta.env.PROD)registerProductionServiceWorker();else void clearDevelopmentServiceWorkers()
