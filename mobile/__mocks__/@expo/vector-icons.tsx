import { Text } from 'react-native';

/** Tests cannot load icon fonts, so an icon is just its name as text (it is hidden from screen readers like the real one). */
export const Ionicons = ({ name }: { name: string }) => <Text accessible={false}>{`[${name}]`}</Text>;
