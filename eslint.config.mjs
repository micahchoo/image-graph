import {defineConfig} from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
  {ignores:['dist/**','node_modules/**','tests/**','*.mjs']},
  ...obsidianmd.configs.recommended,
  {languageOptions:{parserOptions:{projectService:true}}},
  {rules:{'obsidianmd/ui/sentence-case':['warn',{brands:['Image Annotation']}]}},
]);
