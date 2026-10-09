import { describe, expect, it } from 'vitest';

import {
  BAZAAR_BODY_METHODS,
  BAZAAR_BODY_TYPES,
  BAZAAR_QUERY_METHODS,
  bazaarExtension,
  create402Response,
  type BazaarExtensionOptions,
} from './index';
import * as root from '../index';

/**
 * The x402 `bazaar` extension, pinned to its spec:
 * specs/extensions/bazaar.md in coinbase/x402, main @ dd927a26 (2026-04-21).
 * The `info` objects below are copied from the spec's own examples.
 */

/**
 * The subset of JSON Schema (draft 2020-12) that the emitted schemas use:
 * type, const, enum, properties, required, additionalProperties. Facilitators
 * MUST validate `info` against `schema` before cataloging, so every shape the
 * helper builds has to pass its own schema.
 */
function schemaErrors(value: unknown, schema: Record<string, unknown>, path = 'info'): string[] {
  const errors: string[] = [];
  const typeOf = (v: unknown) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (typeof schema.type === 'string' && typeOf(value) !== schema.type) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) errors.push(`${path}: missing required ${key}`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...schemaErrors(v, props[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: additional property ${key}`);
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(
          ...schemaErrors(v, schema.additionalProperties as Record<string, unknown>, `${path}.${key}`)
        );
      }
    }
  }
  return errors;
}

function infoAndSchema(options: BazaarExtensionOptions) {
  const { bazaar } = bazaarExtension(options);
  return { info: bazaar.info, schema: bazaar.schema };
}

function inputSchema(schema: Record<string, unknown>) {
  return (schema.properties as Record<string, Record<string, unknown>>).input;
}

describe('bazaarExtension', () => {
  describe('the spec examples', () => {
    it('POST endpoint: info is the spec example, byte for byte', () => {
      const { info, schema } = infoAndSchema({
        method: 'POST',
        body: { query: 'example' },
        output: { example: { results: [] } },
      });

      expect(info).toEqual({
        input: {
          type: 'http',
          method: 'POST',
          bodyType: 'json',
          body: { query: 'example' },
        },
        output: { type: 'json', example: { results: [] } },
      });
      expect(JSON.stringify(info.input)).toBe(
        '{"type":"http","method":"POST","bodyType":"json","body":{"query":"example"}}'
      );
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.required).toEqual(['input']);
      expect(inputSchema(schema)).toMatchObject({
        type: 'object',
        required: ['type', 'method', 'bodyType', 'body'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
          bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
          body: { type: 'object' },
        },
      });
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it('GET endpoint: info is the spec example, byte for byte', () => {
      const { info, schema } = infoAndSchema({
        method: 'GET',
        queryParams: { city: 'San Francisco' },
        queryParamsSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        output: {
          example: { city: 'San Francisco', weather: 'foggy', temperature: 60 },
        },
      });

      expect(info).toEqual({
        input: {
          type: 'http',
          method: 'GET',
          queryParams: { city: 'San Francisco' },
        },
        output: {
          type: 'json',
          example: { city: 'San Francisco', weather: 'foggy', temperature: 60 },
        },
      });
      expect(inputSchema(schema)).toMatchObject({
        required: ['type', 'method'],
        additionalProperties: false,
        properties: {
          method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
          queryParams: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      });
      expect(inputSchema(schema).properties).not.toHaveProperty('body');
      expect(inputSchema(schema).properties).not.toHaveProperty('bodyType');
      expect(schemaErrors(info, schema)).toEqual([]);
    });
  });

  describe('method', () => {
    it('lists the methods the spec names', () => {
      expect(BAZAAR_QUERY_METHODS).toEqual(['GET', 'HEAD', 'DELETE']);
      expect(BAZAAR_BODY_METHODS).toEqual(['POST', 'PUT', 'PATCH']);
      expect(BAZAAR_BODY_TYPES).toEqual(['json', 'form-data', 'text']);
    });

    it.each([...BAZAAR_BODY_METHODS])('%s carries a body and validates', (method) => {
      const { info, schema } = infoAndSchema({ method, body: { id: 7 } });
      expect(info.input).toEqual({ type: 'http', method, bodyType: 'json', body: { id: 7 } });
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it.each([...BAZAAR_QUERY_METHODS])('%s carries no body and validates', (method) => {
      const { info, schema } = infoAndSchema({ method });
      expect(info.input).toEqual({ type: 'http', method });
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it('is emitted uppercased, without spaces', () => {
      const { info, schema } = infoAndSchema({
        method: ' patch ' as 'PATCH',
        body: {},
      });
      expect((info.input as Record<string, unknown>).method).toBe('PATCH');
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it.each(['CONNECT', 'OPTIONS', 'TRACE', '', 'GET /x', undefined])(
      'refuses %o',
      (method) => {
        expect(() =>
          bazaarExtension({ method } as unknown as BazaarExtensionOptions)
        ).toThrow(/bazaarExtension: method must be one of GET, HEAD, DELETE, POST, PUT, PATCH/);
      }
    );
  });

  describe('body', () => {
    it('places bodySchema where it validates the example body', () => {
      const bodySchema = {
        type: 'object',
        properties: { phone: { type: 'string' } },
        required: ['phone'],
      };
      const { info, schema } = infoAndSchema({
        method: 'POST',
        body: { phone: '+573001234567' },
        bodySchema,
      });

      expect(inputSchema(schema).properties).toMatchObject({ body: bodySchema });
      expect(schemaErrors(info, schema)).toEqual([]);
      // and it does validate: a body without the required field fails
      const bad = { input: { ...(info.input as object), body: {} } };
      expect(schemaErrors(bad, schema)).toEqual(['info.input.body: missing required phone']);
    });

    it('takes an empty object as the example of an endpoint with no input', () => {
      const { info, schema } = infoAndSchema({ method: 'POST', body: {} });
      expect((info.input as Record<string, unknown>).body).toEqual({});
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it.each(['form-data', 'text'] as const)('honours bodyType %s', (bodyType) => {
      const body = bodyType === 'text' ? 'plain text prompt' : { field: 'value' };
      const { info, schema } = infoAndSchema({ method: 'PUT', bodyType, body });
      expect(info.input).toEqual({ type: 'http', method: 'PUT', bodyType, body });
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it.each([
      [{ method: 'POST' }, /POST needs body, the example request body/],
      [{ method: 'PUT', body: null }, /PUT needs body/],
      [{ method: 'PATCH', body: [1, 2] }, /body must be an object when bodyType is json/],
      [{ method: 'POST', body: 'text' }, /body must be an object when bodyType is json/],
      [{ method: 'POST', bodyType: 'text', body: { a: 1 } }, /body must be a string when bodyType is text/],
      [{ method: 'POST', bodyType: 'xml', body: {} }, /bodyType must be one of json, form-data, text/],
      [{ method: 'POST', body: {}, bodySchema: 'object' }, /bodySchema must be an object/],
      [{ method: 'GET', body: {} }, /GET takes its input in the query string/],
      [{ method: 'DELETE', bodyType: 'json' }, /DELETE takes its input in the query string/],
      [{ method: 'HEAD', bodySchema: {} }, /HEAD takes its input in the query string/],
    ])('refuses %o', (options, message) => {
      expect(() =>
        bazaarExtension(options as unknown as BazaarExtensionOptions)
      ).toThrow(message);
    });
  });

  describe('query parameters, headers and output', () => {
    it('emits queryParams and headers next to a body', () => {
      const { info, schema } = infoAndSchema({
        method: 'POST',
        body: { q: 'x' },
        queryParams: { lang: 'es' },
        headers: { 'X-Client': 'agent' },
      });
      expect(info.input).toEqual({
        type: 'http',
        method: 'POST',
        bodyType: 'json',
        body: { q: 'x' },
        queryParams: { lang: 'es' },
        headers: { 'X-Client': 'agent' },
      });
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it('keeps output out of info when it is not given', () => {
      const { info, schema } = infoAndSchema({ method: 'GET' });
      expect(info).not.toHaveProperty('output');
      expect(schema.properties).not.toHaveProperty('output');
    });

    it('defaults output.type to json and places output.schema over the example', () => {
      const outputSchema = { type: 'object', required: ['owner'] };
      const { info, schema } = infoAndSchema({
        method: 'GET',
        output: { example: { owner: 'ACME' }, schema: outputSchema, format: 'v1' },
      });
      expect(info.output).toEqual({ type: 'json', format: 'v1', example: { owner: 'ACME' } });
      expect(
        (schema.properties as Record<string, Record<string, Record<string, unknown>>>).output
          .properties.example
      ).toEqual(outputSchema);
      expect(schemaErrors(info, schema)).toEqual([]);
    });

    it.each([
      [{ method: 'GET', queryParams: 'city=x' }, /queryParams must be an object/],
      [{ method: 'GET', queryParams: ['city'] }, /queryParams must be an object/],
      [{ method: 'GET', headers: { 'X-N': 1 } }, /headers must be an object of strings/],
      [{ method: 'GET', output: { type: '' } }, /output.type must be a non-empty string/],
      [{ method: 'GET', output: { schema: [] } }, /output.schema must be an object/],
      [{ method: 'GET', queryParamsSchema: true }, /queryParamsSchema must be an object/],
    ])('refuses %o', (options, message) => {
      expect(() =>
        bazaarExtension(options as unknown as BazaarExtensionOptions)
      ).toThrow(message);
    });
  });

  it('is exported from the package root', () => {
    expect(root.bazaarExtension).toBe(bazaarExtension);
  });
});

describe('create402Response extensions', () => {
  const V2 = {
    amount: '0.05',
    recipient: '0x1234567890123456789012345678901234567890',
    resource: 'https://api.example.com/search',
    chainName: 'base',
    x402Version: 2 as const,
  };

  it('without extensions, the response is what it was before the option existed', () => {
    const before = create402Response(V2);
    expect(before.body).not.toHaveProperty('extensions');
    expect(create402Response(V2, {})).toEqual(before);
    expect(create402Response(V2, { extensions: undefined })).toEqual(before);
    expect(JSON.stringify(create402Response(V2, { extensions: undefined }).body)).toBe(
      JSON.stringify(before.body)
    );

    const v1 = { ...V2, x402Version: undefined };
    expect(create402Response(v1).body).not.toHaveProperty('extensions');
    expect(create402Response(v1).body.x402Version).toBe(1);
  });

  it('puts the bazaar declaration, info.input.method included, in the v2 body', () => {
    const extensions = bazaarExtension({
      method: 'POST',
      body: { query: 'example' },
      output: { example: { results: [] } },
    });
    const { status, body } = create402Response(V2, { extensions });

    expect(status).toBe(402);
    expect(body.x402Version).toBe(2);
    const bazaar = (body.extensions as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
      .bazaar;
    expect(bazaar.info.input.method).toBe('POST');
    expect(bazaar.info.input.body).toEqual({ query: 'example' });
    // the rest of the body does not move
    const { extensions: _ext, ...rest } = body;
    expect(rest).toEqual(create402Response(V2).body);
  });

  it('keeps other extensions next to bazaar', () => {
    const { body } = create402Response(V2, {
      extensions: { ...bazaarExtension({ method: 'GET' }), 'offer-receipt/1': { info: {} } },
    });
    expect(Object.keys(body.extensions as object)).toEqual(['bazaar', 'offer-receipt/1']);
  });

  it('refuses extensions on a v1 response instead of dropping them', () => {
    expect(() =>
      create402Response(
        { ...V2, x402Version: undefined },
        { extensions: bazaarExtension({ method: 'GET' }) }
      )
    ).toThrow(/extensions need an x402 v2 response/);
  });

  it.each([null, [], 'bazaar'])('refuses extensions %o', (extensions) => {
    expect(() =>
      create402Response(V2, {
        extensions: extensions as unknown as Record<string, unknown>,
      })
    ).toThrow(/extensions must be an object/);
  });
});
