import { createContext, useContext } from 'react';

/** True inside an AppShell with layout="phone": a component there drops what the phone's tab bar already offers. */
const PhoneLayoutContext = createContext(false);
export const PhoneLayoutProvider = PhoneLayoutContext.Provider;
export const usePhoneLayout = () => useContext(PhoneLayoutContext);
