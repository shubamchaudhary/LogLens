import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/auth';

/** Signs in as the guest (if needed) and opens the app on the 1 GB guest session. */
export function useGuestLaunch() {
  const { user, guestLogin } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const launch = async () => {
    setBusy(true);
    try {
      if (!user) await guestLogin();
      navigate('/app');
    } finally {
      setBusy(false);
    }
  };
  return { launch, busy, user };
}
