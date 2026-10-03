type DevinLogoProps = {
  className?: string;
};

const DevinLogo = ({ className = 'w-5 h-5' }: DevinLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Devin"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M8 6.5h4.5c3 0 5.5 2.4 5.5 5.5s-2.5 5.5-5.5 5.5H8z"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default DevinLogo;
