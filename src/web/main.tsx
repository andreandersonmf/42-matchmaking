import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import App from './App';
import { I18nProvider } from './i18n';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('O elemento raiz da aplicação não foi encontrado.');
ReactDOM.createRoot(root).render(<React.StrictMode><I18nProvider><App/></I18nProvider></React.StrictMode>);
