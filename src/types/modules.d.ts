declare module 'bcryptjs' {
  export function genSalt(rounds?: number): Promise<string>;
  export function hash(s: string, salt: string | number): Promise<string>;
  export function compare(s: string, hash: string): Promise<boolean>;
}

declare module 'jsonwebtoken' {
  export function sign(payload: string | Buffer | object, secretOrPrivateKey: string, options?: any): string;
  export function verify(token: string, secretOrPublicKey: string, options?: any): any;
  export function decode(token: string, options?: any): null | { [key: string]: any } | string;
}
