import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, parseConfig, projectFromOrigin } from '../src/config';

const issues = (value: unknown) =>
	'issues' in parseConfig(value) ? (parseConfig(value) as { issues: string[] }).issues : [];

describe('parseConfig', () => {
	test('an empty file means the defaults and no projects', () => {
		expect(parseConfig({})).toEqual({ config: DEFAULT_CONFIG });
	});

	test('rejects what would silently misbehave: typos, duplicate names, bad regexes, conflicting deploy sources', () => {
		expect(issues({ build: { command: 'cargo auto', step: ['test'] } })).toEqual(['build.step: must be removed']);
		expect(
			issues({
				projects: [
					{ name: 'a', origin: 'x' },
					{ name: 'a', origin: 'y' },
				],
			}),
		).toHaveLength(1);
		expect(issues({ projects: [{ name: 'a', origin: '(' }] })[0]).toStartWith('projects.0.origin');
		const both = { unit: 'dev', deployedShaFile: 'a', servedCheckoutFile: 'b' };
		expect(issues({ projects: [{ name: 'a', origin: 'x', devServer: both }] })[0]).toStartWith('projects.0.devServer');
		const stampOnly = { unit: 'dev', builtStamp: { file: 'f', paths: ['src'] } };
		expect(issues({ projects: [{ name: 'a', origin: 'x', devServer: stampOnly }] })).toHaveLength(1);
	});
});

describe('projectFromOrigin', () => {
	test('the pattern matches the repository over ssh and https, not a longer name or another owner', () => {
		const { origin } = projectFromOrigin('app', 'git@github.com:acme/app.git');
		const re = new RegExp(origin, 'i');
		expect(re.test('git@github.com:acme/app.git')).toBe(true);
		expect(re.test('https://github.com/acme/app')).toBe(true);
		expect(re.test('https://github.com/acme/app-web.git')).toBe(false);
		expect(re.test('https://github.com/notacme/app.git')).toBe(false);
	});
});
