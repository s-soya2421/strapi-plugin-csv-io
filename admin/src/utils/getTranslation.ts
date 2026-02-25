import { pluginId } from '../pluginId';

const getTranslation = (id: string): string => `${pluginId}.${id}`;

export { getTranslation };
