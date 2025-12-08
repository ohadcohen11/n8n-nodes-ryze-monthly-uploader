import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MySql implements ICredentialType {
	name = 'mySql';
	displayName = 'MySQL';
	documentationUrl = 'https://dev.mysql.com/doc/';
	properties: INodeProperties[] = [
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'localhost',
			required: true,
			description: 'MySQL server hostname or IP address',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 3306,
			required: true,
			description: 'MySQL server port',
		},
		{
			displayName: 'Database',
			name: 'database',
			type: 'string',
			default: '',
			required: true,
			description: 'Database name',
		},
		{
			displayName: 'User',
			name: 'user',
			type: 'string',
			default: '',
			required: true,
			description: 'MySQL username',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'MySQL password',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.host}}:{{$credentials.port}}',
			method: 'GET',
		},
	};
}
