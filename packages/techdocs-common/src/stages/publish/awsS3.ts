/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import path from 'path';
import express from 'express';
import aws from 'aws-sdk';
import { Logger } from 'winston';
import { Entity, EntityName } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { getHeadersForFileExtension, getFileTreeRecursively } from './helpers';
import { PublisherBase, PublishRequest } from './types';
import { CredentialsOptions } from 'aws-sdk/lib/credentials';
import { ManagedUpload } from 'aws-sdk/clients/s3';
import fs from 'fs';

export class AwsS3Publish implements PublisherBase {
  static fromConfig(config: Config, logger: Logger): PublisherBase {
    let credentials = '';
    let bucketName = '';
    try {
      credentials = config.getString('techdocs.publisher.awsS3.credentials');
      bucketName = config.getString('techdocs.publisher.awsS3.bucketName');
    } catch (error) {
      throw new Error(
        "Since techdocs.publisher.type is set to 'awsS3' in your app config, " +
          'credentials and bucketName are required in techdocs.publisher.awsS3 ' +
          'required to authenticate with AWS S3.',
      );
    }

    let credentialsJson = {};
    try {
      credentialsJson = JSON.parse(credentials);
    } catch (err) {
      throw new Error(
        'Error in parsing techdocs.publisher.awsS3.credentials config to JSON.',
      );
    }

    const storageClient = new aws.S3({
      credentials: credentialsJson as CredentialsOptions,
    });

    // Check if the defined bucket exists. Being able to connect means the configuration is good
    // and the storage client will work.
    storageClient
      .headObject({
        Bucket: bucketName,
        Key: (credentialsJson as CredentialsOptions).accessKeyId,
      })
      .promise()
      .then(() => {
        logger.info(
          `Successfully connected to the AWS S3 bucket ${bucketName}.`,
        );
      })
      .catch(reason => {
        logger.error(
          `Could not retrieve metadata about the AWS S3 bucket ${bucketName}. ` +
            'Make sure the AWS project and the bucket exists and the access key located at the path ' +
            "techdocs.publisher.awsS3.credentials defined in app config has the role 'Storage Object Creator'. " +
            'Refer to https://backstage.io/docs/features/techdocs/using-cloud-storage',
        );
        throw new Error(`from AWS client library: ${reason.message}`);
      });

    return new AwsS3Publish(storageClient, bucketName, logger);
  }

  constructor(
    private readonly storageClient: aws.S3,
    private readonly bucketName: string,
    private readonly logger: Logger,
  ) {
    this.storageClient = storageClient;
    this.bucketName = bucketName;
    this.logger = logger;
  }

  /**
   * Upload all the files from the generated `directory` to the S3 bucket.
   * Directory structure used in the bucket is - entityNamespace/entityKind/entityName/index.html
   */
  publish({ entity, directory }: PublishRequest): Promise<void> {
    return new Promise(async (resolve, reject) => {
      // Note: GCS manages creation of parent directories if they do not exist.
      // So collecting path of only the files is good enough.
      const allFilesToUpload = await getFileTreeRecursively(directory);

      const uploadPromises: Array<Promise<ManagedUpload.SendData>> = [];
      allFilesToUpload.forEach(filePath => {
        // Remove the absolute path prefix of the source directory
        // Path of all files to upload, relative to the root of the source directory
        // e.g. ['index.html', 'sub-page/index.html', 'assets/images/favicon.png']
        const relativeFilePath = filePath.replace(`${directory}/`, '');
        const entityRootDir = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
        const destination = `${entityRootDir}/${relativeFilePath}`; // S3 Bucket file relative path

        fs.readFile(filePath, (err, data) => {
          if (err) {
            reject(err);
          }

          const params = {
            Bucket: this.bucketName,
            Key: destination,
            Body: data,
          };

          // TODO: Upload in chunks of ~10 files instead of all files at once.
          uploadPromises.push(this.storageClient.upload(params).promise());
        });
      });

      Promise.all(uploadPromises)
        .then(() => {
          this.logger.info(
            `Successfully uploaded all the generated files for Entity ${entity.metadata.name}. Total number of files: ${allFilesToUpload.length}`,
          );
          resolve(undefined);
        })
        .catch((err: Error) => {
          const errorMessage = `Unable to upload file(s) to AWS S3. Error ${err.message}`;
          this.logger.error(errorMessage);
          reject(errorMessage);
        });
    });
  }

  fetchTechDocsMetadata(entityName: EntityName): Promise<string> {
    return new Promise((resolve, reject) => {
      const entityRootDir = `${entityName.namespace}/${entityName.kind}/${entityName.name}`;

      const fileStreamChunks: Array<any> = [];
      this.storageClient
        .headObject({
          Bucket: this.bucketName,
          Key: `${entityRootDir}/techdocs_metadata.json`,
        })
        .createReadStream()
        .on('error', err => {
          this.logger.error(err.message);
          reject(err.message);
        })
        .on('data', chunk => {
          fileStreamChunks.push(chunk);
        })
        .on('end', () => {
          const techdocsMetadataJson = Buffer.concat(
            fileStreamChunks,
          ).toString();
          resolve(techdocsMetadataJson);
        });
    });
  }

  /**
   * Express route middleware to serve static files on a route in techdocs-backend.
   */
  docsRouter(): express.Handler {
    return (req, res) => {
      // Trim the leading forward slash
      // filePath example - /default/Component/documented-component/index.html
      const filePath = req.path.replace(/^\//, '');

      // Files with different extensions (CSS, HTML) need to be served with different headers
      const fileExtension = path.extname(filePath);
      const responseHeaders = getHeadersForFileExtension(fileExtension);

      const fileStreamChunks: Array<any> = [];
      this.storageClient
        .getObject({ Bucket: this.bucketName, Key: filePath })
        .createReadStream()
        .on('error', err => {
          this.logger.warn(err.message);
          res.status(404).send(err.message);
        })
        .on('data', chunk => {
          fileStreamChunks.push(chunk);
        })
        .on('end', () => {
          const fileContent = Buffer.concat(fileStreamChunks).toString();
          // Inject response headers
          for (const [headerKey, headerValue] of Object.entries(
            responseHeaders,
          )) {
            res.setHeader(headerKey, headerValue);
          }

          res.send(fileContent);
        });
    };
  }

  /**
   * A helper function which checks if index.html of an Entity's docs site is available. This
   * can be used to verify if there are any pre-generated docs available to serve.
   */
  async hasDocsBeenGenerated(entity: Entity): Promise<boolean> {
    return new Promise(resolve => {
      const entityRootDir = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
      this.storageClient
        .getObject({
          Bucket: this.bucketName,
          Key: `${entityRootDir}/index.html`,
        })
        .promise()
        .then(() => {
          resolve(true);
        })
        .catch(() => {
          resolve(false);
        });
    });
  }
}
