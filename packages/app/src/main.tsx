import { render } from 'solid-js/web';
import { Workspace } from './workspace/Workspace';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
render(() => <Workspace />, root);
