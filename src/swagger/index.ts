import * as LambdaProxy from "../lambda-proxy";
import { Namespace, Routes } from "../namespace";
import { HttpMethod, JSONSchema, Route} from "../route";
import { flattenRoutes } from "../router";

import * as Joi from "joi";
import * as _ from "lodash";
import * as Swagger from "swagger-schema-official";
import * as _string from "underscore.string";

import JoiToJSONSchema = require("@vingle/joi-to-json-schema");

function deepOmit(obj: any, keysToOmit: string[]) {
  const keysToOmitIndex = _.keyBy(keysToOmit); // create an index object of the keys that should be omitted

  const omitFromObject = (objectToOmit: any) => {
    // the inner function which will be called recursively
    return _.transform(objectToOmit, function(result, value, key) { // transform to a new object
      if (key in keysToOmitIndex) { // if the key is in the index skip it
        return;
      }

      // if the key is an object run it through the inner function - omitFromObject
      result[key] = _.isObject(value) ? omitFromObject(value) : value;
    });
  };

  return omitFromObject(obj); // return the inner function result
}

function JoiToSwaggerSchema(joiSchema: Joi.Schema) {
  return deepOmit(JoiToJSONSchema(joiSchema), ["additionalProperties", "patterns"]) as any;
}

function asJoiSchema(object: any): Joi.Schema | undefined {
  if ((object as Joi.Schema).isJoi) {
    return object;
  } else {
    return undefined;
  }
}

export type SwaggerRouteOptions = (
  Swagger.Info &
  { definitions?: { [definitionsName: string]: Joi.Schema | JSONSchema } }
);

export class SwaggerRoute extends Namespace {
  constructor(
    path: string,
    info: SwaggerRouteOptions,
    routes: Routes
  ) {

    const CorsHeaders = function(origin: string) {
      return {
        "Access-Control-Allow-Origin": origin || "",
        "Access-Control-Allow-Headers": [
          "Content-Type",
        ].join(", "),
        "Access-Control-Allow-Methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", "),
        "Access-Control-Max-Age": `${60 * 60 * 24 * 30}`,
      };
    };

    super(path, {
      children: [
        Route.OPTIONS(
          "/", { desc: "CORS Preflight Endpoint for Swagger Documentation API", operationId: "optionSwagger" }, {},
          async function() {
            return this.json("", 204, CorsHeaders(this.headers.origin));
          }),

        Route.GET("/", { desc: "Swagger Documentation API", operationId: "getSwagger" }, {},
          async function() {
            const docGenerator = new SwaggerGenerator();
            const json = docGenerator.generateJSON(info, this.request, routes);
            return this.json(json, 200, CorsHeaders(this.headers.origin));
          }),
      ],
    });
  }
}

export class SwaggerGenerator {
  constructor() {
    //
  }

  public generateJSON(info: SwaggerRouteOptions, request: LambdaProxy.Event, cascadedRoutes: Routes): Swagger.Spec {
    const paths: { [pathName: string]: Swagger.Path } = {};

    // Try to convert to reference, and if it fails return original scchema
    const convertToReference = (schema: Joi.Schema | JSONSchema) => {
      if (info.definitions) {
        // tslint:disable-next-line:forin
        for (const name in info.definitions) {
          const def = info.definitions[name];
          // Same "ADDRESS"
          if (def === schema) {
            return { $ref: `#/definitions/${name}` };
          }
        }
      }

      return undefined;
    };

    flattenRoutes(cascadedRoutes).forEach((routes) => {
      const endRoute = (routes[routes.length - 1] as Route);
      const corgiPath = routes.map(r => r.path).join("");
      const swaggerPath = this.toSwaggerPath(corgiPath);

      if (!paths[swaggerPath]) {
        paths[swaggerPath] = {} as Swagger.Path;
      }
      const operation: Swagger.Operation = {
        description: endRoute.description,
        produces: [
          "application/json; charset=utf-8"
        ],
        parameters: _.flatMap(routes, (route) => {
          if (route instanceof Namespace) {
            // Namespace only supports path
            return _.map(route.params, (schema, name) => {
              const joiSchema = JoiToSwaggerSchema(schema);
              const param: Swagger.PathParameter = {
                in: "path",
                name,
                description: "",
                type: joiSchema.type,
                required: true
              };
              return param;
            });
          } else {
            return _.map(route.params, (paramDef, name) => {
              const joiSchemaMetadata = paramDef.def.describe();

              if (paramDef.in === "body") {
                const joiSchema = JoiToSwaggerSchema(paramDef.def);
                const param: Swagger.Parameter = {
                  in: paramDef.in,
                  name,
                  description: "",
                  schema: joiSchema,
                  // current joi typing doesn't have type definition for flags
                  // @see https://github.com/hapijs/joi/blob/v12/lib/types/any/index.js#L48-L64
                  required: ((joiSchemaMetadata.flags || {}) as any).presence !== "optional",
                };
                return param;
              } else {
                const joiSchema = JoiToSwaggerSchema(paramDef.def);
                const param: Swagger.Parameter = Object.assign({
                  in: paramDef.in,
                  name,
                  description: "",
                }, joiSchema);

                if (paramDef.in === "path") {
                  param.required = true;
                } else { // query param
                  param.required = ((joiSchemaMetadata.flags || {}) as any).presence !== "optional";
                }

                return param;
              }
            });
          }
        }).map((param) => deepOmit(param, ["additionalProperties", "patterns"])) as any,
        responses: (() => {
          if (endRoute.responses) {
            return Array.from(endRoute.responses)
              .reduce((obj, [statusCode, response]) => {
                let schema: Swagger.Schema | undefined;
                if (response.schema) {
                  const reference = convertToReference(response.schema);
                  if (reference) {
                    schema = reference;
                  } else {
                    if (asJoiSchema(response.schema)) {
                      // Joi Schema
                      schema = JoiToSwaggerSchema(response.schema as Joi.Schema);
                    } else {
                      // Raw JSON Schema, Good to go!
                      schema = response.schema as Swagger.Schema;
                    }
                  }
                }

                obj[statusCode] = {
                  description: response.desc || "",
                  schema,
                };
                return obj;
              }, {} as { [key: string]: Swagger.Response });
          } else {
            return {
              200: {
                description: "Success"
              }
            };
          }
        })(),
        operationId: endRoute.operationId || this.routesToOperationId(corgiPath, endRoute.method),
      };
      paths[swaggerPath][(() => {
        switch (endRoute.method) {
          case "GET": return "get";
          case "PUT": return "put";
          case "POST": return "post";
          case "PATCH": return "patch";
          case "DELETE": return "delete";
          case "OPTIONS": return "options";
          case "HEAD": return "head";
        }
      })()] = operation;
    });

    const swagger: Swagger.Spec = {
      swagger: "2.0",
      info: {
        title: info.title,
        version: info.version,
        description: info.description,
        termsOfService: info.termsOfService,
        contact: info.contact,
        license: info.license,
      },
      host: request.headers.Host,
      basePath: `/${request.requestContext!.stage}/`,
      schemes: [
        request.headers["X-Forwarded-Proto"]
      ],
      produces: [
        "application/json; charset=utf-8",
      ],
      paths,
      tags: [],
      definitions: _.mapValues(info.definitions || {}, (schema) => {
        if (asJoiSchema(schema)) {
          return JoiToSwaggerSchema(schema as Joi.Schema);
        } else {
          return schema;
        }
      }),
    };

    return swagger;
  }

  public toSwaggerPath(path: string) {
    return path.replace(/\:(\w+)/g, "{$1}");
  }

  public routesToOperationId(path: string, method: HttpMethod) {
    const operation =
      path.split("/").map((c) => {
        if (c.startsWith(":")) {
          return _string.capitalize(c.slice(1));
        } else {
          return _string.capitalize(c);
        }
      }).join("");

    return `${_string.capitalize(method.toLowerCase())}${operation}`;
  }
}
