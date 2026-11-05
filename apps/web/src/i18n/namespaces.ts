/** Message namespaces – one JSON file per namespace and locale under /messages/<locale>/. */
export const MESSAGE_NAMESPACES = ['common', 'shop', 'queue', 'cart', 'admin', 'editor'] as const;
export type MessageNamespace = (typeof MESSAGE_NAMESPACES)[number];
