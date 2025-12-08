import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AwsS3Api implements ICredentialType {
	name = 'awsS3Api';
	displayName = 'AWS S3 API';
	documentationUrl = 'https://docs.aws.amazon.com/general/latest/gr/aws-sec-cred-types.html';
	icon = 'file:aws.svg' as const;
	properties: INodeProperties[] = [
		{
			displayName: 'Access Key ID',
			name: 'accessKeyId',
			type: 'string',
			default: '',
			required: true,
			description: 'AWS Access Key ID',
		},
		{
			displayName: 'Secret Access Key',
			name: 'secretAccessKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'AWS Secret Access Key',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'string',
			default: 'us-east-1',
			required: true,
			description: 'AWS Region (e.g., us-east-1, eu-west-1)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '=https://s3.{{$credentials.region}}.amazonaws.com',
			method: 'GET',
		},
	};
}
