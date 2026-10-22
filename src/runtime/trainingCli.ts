#!/usr/bin/env node
import { launch } from '../training/cli/index.js';
import { trainingDependencies } from './trainingSubjects.js';

await launch(process.argv.slice(2), await trainingDependencies());
