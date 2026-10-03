// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClprApplication} from "@hiero-ledger/clpr/interfaces/IClprApplication.sol";
import {SettleTypes} from "./SettleTypes.sol";
import {ISettlePaymentProver} from "./interfaces/ISettlePaymentProver.sol";

/// @title SettleOrderBook
/// @notice The Hedera side of "settle on Hedera". Connectors post bonds here (HBAR or an HTS token such as USDC).
///         A proven deposit on chain Y opens an order and reserves cover + penalty from the Connector's bond; a
///         proven delivery on chain X closes it and frees the reservation; if the deadline passes without a proven
///         delivery, anyone can have the user paid cover + penalty from the bond on Hedera.
/// @dev Proofs only flow chain → Hedera:
///        - EVM chains: `SettleDeposit` / `SettleDelivery` send CLPR messages; the ClprService on Hedera delivers
///          them here ({onClprMessage}) after the Channel's verifier checked them. Each Channel is registered as a
///          source with the two contracts allowed to speak for its ledger.
///        - Chains whose CLPR verifier proves plain transactions: a registered {ISettlePaymentProver} proves a
///          payment carrying the order id ({openByPayment}, {closeByPayment}).
///
///      Bond accounting per (Connector, asset): `total` = reserved + pending withdrawal + free. Capacity is the
///      bond: an order reserves cover + penalty, first from free, then from a pending withdrawal. If that is not
///      enough the order is still opened with what could be reserved and the shortfall is counted against the
///      Connector ({CoverShortfall}); clients check capacity before depositing.
///
///      Processing a CLPR message never makes an external call and never reverts for a well-formed message from
///      a registered sender: invalid content is recorded (rejected order, ignored duplicate) instead, so a message
///      cannot be lost to a revert of this contract.
///
///      No upgrade, no pause. The admin can only register new sources and payment provers, each after
///      `SOURCE_NOTICE`, at most one of each per ledger, never replaced or removed; it cannot touch bonds or orders.
contract SettleOrderBook is IClprApplication, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Status {
        NONE,
        OPEN,
        DELIVERED,
        DEFAULTED,
        CANCELLED,
        REJECTED
    }

    enum Reject {
        NONE,
        UNKNOWN_CONNECTOR,
        BAD_SIGNATURE,
        WRONG_SOURCE
    }

    struct Connector {
        address signer;
        address prevSigner;
        /// @dev When `prevSigner` was replaced; it stays valid for quotes issued up to then.
        uint64 rotatedAt;
        uint64 registeredAt;
        uint32 shortfalls;
    }

    struct Bond {
        uint256 total;
        uint256 reserved;
        uint256 pendingWithdraw;
        uint64 withdrawReadyAt;
    }

    struct Order {
        address connector;
        Status status;
        uint64 deadline;
        address coverAsset;
        uint64 openedAt;
        address refundTo;
        bytes32 dstLedger;
        bytes32 assetOut;
        bytes32 recipient;
        uint256 amountOut;
        /// @dev cover + penalty promised to the user on default.
        uint256 owedOnDefault;
        /// @dev What was actually reserved from the bond (≤ owedOnDefault).
        uint256 reserved;
    }

    struct Source {
        bytes32 ledger;
        bytes32 depositSender;
        bytes32 deliverySender;
        uint64 activeAt;
    }

    struct Prover {
        ISettlePaymentProver prover;
        uint64 activeAt;
    }

    // ── Immutable configuration ─────────────────────────────────────────────

    /// @notice The ClprService on Hedera; the only caller of {onClprMessage}.
    address public immutable CLPR_SERVICE;
    /// @notice Penalty on default, in basis points of the cover.
    uint16 public immutable PENALTY_BPS;
    /// @notice Delay between a withdrawal request and its execution. Must exceed the longest quote lifetime plus
    ///         the time a deposit proof takes to reach Hedera, so a Connector cannot withdraw the bond behind a
    ///         quote it signed.
    uint64 public immutable WITHDRAW_DELAY;
    /// @notice Time after the deadline for a delivery proof to reach Hedera before the order can be defaulted.
    uint64 public immutable PROOF_GRACE;
    /// @notice Longest a quote may live (`expiry - issuedAt`) for a rotated-out signer to still be honoured.
    uint64 public immutable MAX_QUOTE_TTL;
    /// @notice Notice before a new source or payment prover takes effect.
    uint64 public immutable SOURCE_NOTICE;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint64 public constant MIN_WITHDRAW_DELAY = 1 hours;
    uint64 public constant MIN_SOURCE_NOTICE = 1 days;
    uint16 public constant MAX_PENALTY_BPS = 5000;
    /// @notice Gas for a native push; a recipient that needs more is credited instead ({withdrawOwed}).
    uint256 public constant PUSH_GAS = 30_000;
    /// @notice Hedera Token Service system contract.
    address internal constant HTS_PRECOMPILE = address(0x167);

    // ── State ───────────────────────────────────────────────────────────────

    address public admin;
    address public pendingAdmin;

    mapping(address => bool) public isCoverAsset;
    address[] internal _coverAssets;

    mapping(bytes32 channelId => Source) public sources;
    mapping(bytes32 ledger => bytes32 channelId) public channelOfLedger;
    mapping(bytes32 ledger => Prover) public provers;

    mapping(address => Connector) public connectors;
    mapping(address connector => mapping(address asset => Bond)) public bonds;
    mapping(bytes32 orderId => Order) public orders;
    /// @notice Deliveries proven before their order was opened: orderId → keccak256(ledger, delivery) → seen.
    mapping(bytes32 => mapping(bytes32 => bool)) public deliverySeen;
    /// @notice Payment proofs already used: keccak256(ledger, txId) → used.
    mapping(bytes32 => bool) public paymentUsed;
    /// @notice Payouts that could not be pushed: account → asset → amount.
    mapping(address => mapping(address => uint256)) public owed;
    /// @notice Sum of `owed` per asset (accounting check).
    mapping(address => uint256) public totalOwed;

    // ── Events ──────────────────────────────────────────────────────────────

    event ConnectorRegistered(address indexed connector, address signer);
    event SignerRotated(address indexed connector, address oldSigner, address newSigner);
    event BondPosted(address indexed connector, address indexed asset, uint256 amount, uint256 total);
    event WithdrawRequested(address indexed connector, address indexed asset, uint256 amount, uint64 readyAt);
    event WithdrawCancelled(address indexed connector, address indexed asset, uint256 amount);
    event Withdrawn(address indexed connector, address indexed asset, uint256 amount);
    event OrderOpened(
        bytes32 indexed orderId,
        address indexed connector,
        address indexed refundTo,
        bytes32 srcLedger,
        bytes32 dstLedger,
        address coverAsset,
        uint256 owedOnDefault,
        uint256 reserved,
        uint64 deadline
    );
    event OrderRejected(bytes32 indexed orderId, address indexed connector, Reject reason);
    event CoverShortfall(bytes32 indexed orderId, address indexed connector, uint256 needed, uint256 reserved);
    event DuplicateDeposit(bytes32 indexed orderId, bytes32 srcLedger);
    event OrderDelivered(bytes32 indexed orderId, bytes32 deliveryHash, uint64 deliveredAt);
    event DeliveryRecorded(bytes32 indexed orderId, bytes32 indexed deliveryHash, bytes32 ledger);
    event DeliveryMismatch(bytes32 indexed orderId, bytes32 indexed deliveryHash);
    event LateDelivery(bytes32 indexed orderId, bytes32 indexed deliveryHash, Status status);
    event OrderDefaulted(bytes32 indexed orderId, address indexed refundTo, address asset, uint256 paid);
    event OrderCancelled(bytes32 indexed orderId, address indexed refundTo, address asset, uint256 paid);
    event Paid(address indexed to, address indexed asset, uint256 amount);
    event Owed(address indexed to, address indexed asset, uint256 amount);
    event SourceProposed(
        bytes32 indexed channelId, bytes32 indexed ledger, bytes depositSender, bytes deliverySender, uint64 activeAt
    );
    event ProverProposed(bytes32 indexed ledger, address prover, uint64 activeAt);
    event TokenAssociated(address indexed token, int64 responseCode);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    // ── Errors ──────────────────────────────────────────────────────────────

    error OnlyService();
    error OnlyAdmin();
    error UnknownSource();
    error UnauthorizedSender();
    error UnsupportedMessage();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroSigner();
    error RotationTooSoon();
    error NotCoverAsset();
    error WrongValue();
    error ZeroAmount();
    error InsufficientFree();
    error NothingPending();
    error WithdrawNotReady();
    error NotOpen();
    error NotConnector();
    error DeadlineNotPassed();
    error UnknownDelivery();
    error NotMatching();
    error NoProver();
    error PaymentReplayed();
    error PaymentMismatch();
    error SourceExists();
    error BadParams();
    error TransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    /// @param clprService The ClprService on this ledger.
    /// @param coverAssets_ Bond assets: address(0) for HBAR, HTS token EVM addresses (ERC-20 facade) otherwise.
    constructor(
        address clprService,
        address admin_,
        address[] memory coverAssets_,
        uint16 penaltyBps,
        uint64 withdrawDelay,
        uint64 proofGrace,
        uint64 maxQuoteTtl,
        uint64 sourceNotice
    ) {
        if (
            clprService == address(0) || penaltyBps > MAX_PENALTY_BPS || withdrawDelay < MIN_WITHDRAW_DELAY
                || sourceNotice < MIN_SOURCE_NOTICE || maxQuoteTtl == 0 || coverAssets_.length == 0
        ) revert BadParams();
        CLPR_SERVICE = clprService;
        admin = admin_;
        PENALTY_BPS = penaltyBps;
        WITHDRAW_DELAY = withdrawDelay;
        PROOF_GRACE = proofGrace;
        MAX_QUOTE_TTL = maxQuoteTtl;
        SOURCE_NOTICE = sourceNotice;
        DOMAIN_SEPARATOR = SettleTypes.domainSeparator(block.chainid, address(this));
        for (uint256 i = 0; i < coverAssets_.length; i++) {
            if (!isCoverAsset[coverAssets_[i]]) {
                isCoverAsset[coverAssets_[i]] = true;
                _coverAssets.push(coverAssets_[i]);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Views
    // ═════════════════════════════════════════════════════════════════════

    function coverAssets() external view returns (address[] memory) {
        return _coverAssets;
    }

    /// @notice The order id of `q` (its EIP-712 digest under this order book's domain).
    function orderIdOf(SettleTypes.Quote calldata q) external view returns (bytes32) {
        return SettleTypes.orderId(DOMAIN_SEPARATOR, q);
    }

    /// @notice Bond a new order of `connector` can still reserve in `asset`.
    function freeCapacity(address connector, address asset) public view returns (uint256) {
        Bond storage b = bonds[connector][asset];
        return b.total - b.reserved - b.pendingWithdraw;
    }

    /// @notice cover + penalty for a cover of `coverAmount` (saturating).
    function owedFor(uint256 coverAmount) public view returns (uint256) {
        uint256 penalty = Math.mulDiv(coverAmount, PENALTY_BPS, 10_000);
        (bool ok, uint256 sum) = Math.tryAdd(coverAmount, penalty);
        return ok ? sum : type(uint256).max;
    }

    /// @notice Whether `signer` may sign for `connector` a quote issued at `issuedAt` that expires at `expiry`.
    function isValidSigner(address connector, address signer, uint64 issuedAt, uint64 expiry)
        public
        view
        returns (bool)
    {
        Connector storage c = connectors[connector];
        if (signer == address(0) || c.registeredAt == 0) return false;
        if (signer == c.signer) return true;
        return signer == c.prevSigner && issuedAt <= c.rotatedAt && expiry <= c.rotatedAt + MAX_QUOTE_TTL;
    }

    /// @notice Hash under which a delivery proven on `ledger` is recorded.
    function deliveryHash(bytes32 ledger, SettleTypes.Delivery memory d) public pure returns (bytes32) {
        return keccak256(abi.encode(ledger, d));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Connectors and bonds
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Register the caller as a Connector whose quotes are signed by `signer`.
    function register(address signer) external {
        if (signer == address(0)) revert ZeroSigner();
        Connector storage c = connectors[msg.sender];
        if (c.registeredAt != 0) revert AlreadyRegistered();
        c.signer = signer;
        c.registeredAt = uint64(block.timestamp);
        emit ConnectorRegistered(msg.sender, signer);
    }

    /// @notice Replace the quote signer. The old one stays valid for quotes issued up to now that expire within
    ///         `MAX_QUOTE_TTL`, so deposits already under way are honoured; one rotation per `MAX_QUOTE_TTL`.
    function rotateSigner(address signer) external {
        if (signer == address(0)) revert ZeroSigner();
        Connector storage c = connectors[msg.sender];
        if (c.registeredAt == 0) revert NotRegistered();
        if (c.rotatedAt != 0 && block.timestamp < uint256(c.rotatedAt) + MAX_QUOTE_TTL) revert RotationTooSoon();
        emit SignerRotated(msg.sender, c.signer, signer);
        c.prevSigner = c.signer;
        c.signer = signer;
        c.rotatedAt = uint64(block.timestamp);
    }

    /// @notice Add to the caller's bond in `asset` (HBAR: send `amount` as value; token: approve first).
    function postBond(address asset, uint256 amount) external payable nonReentrant {
        if (connectors[msg.sender].registeredAt == 0) revert NotRegistered();
        if (!isCoverAsset[asset]) revert NotCoverAsset();
        if (amount == 0) revert ZeroAmount();
        if (asset == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
            if (IERC20(asset).balanceOf(address(this)) - before != amount) revert WrongValue();
        }
        Bond storage b = bonds[msg.sender][asset];
        b.total += amount;
        emit BondPosted(msg.sender, asset, amount, b.total);
    }

    /// @notice Start withdrawing `amount` of free bond. It stops backing new orders now, can still be drawn by
    ///         orders proven before it is executed, and is paid out after `WITHDRAW_DELAY` (each request restarts
    ///         the delay for the whole pending amount).
    function requestWithdraw(address asset, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > freeCapacity(msg.sender, asset)) revert InsufficientFree();
        Bond storage b = bonds[msg.sender][asset];
        b.pendingWithdraw += amount;
        b.withdrawReadyAt = uint64(block.timestamp) + WITHDRAW_DELAY;
        emit WithdrawRequested(msg.sender, asset, b.pendingWithdraw, b.withdrawReadyAt);
    }

    function cancelWithdraw(address asset) external {
        Bond storage b = bonds[msg.sender][asset];
        uint256 amt = b.pendingWithdraw;
        if (amt == 0) revert NothingPending();
        b.pendingWithdraw = 0;
        b.withdrawReadyAt = 0;
        emit WithdrawCancelled(msg.sender, asset, amt);
    }

    function executeWithdraw(address asset) external nonReentrant {
        Bond storage b = bonds[msg.sender][asset];
        uint256 amt = b.pendingWithdraw;
        if (amt == 0) revert NothingPending();
        if (block.timestamp < b.withdrawReadyAt) revert WithdrawNotReady();
        b.pendingWithdraw = 0;
        b.withdrawReadyAt = 0;
        b.total -= amt;
        emit Withdrawn(msg.sender, asset, amt);
        _transferOut(asset, msg.sender, amt);
    }

    // ═════════════════════════════════════════════════════════════════════
    // CLPR delivery (EVM sources)
    // ═════════════════════════════════════════════════════════════════════

    /// @inheritdoc IClprApplication
    function onClprMessage(bytes32 channelId, bytes calldata sender, bytes calldata messageData)
        external
        nonReentrant
        returns (bytes memory)
    {
        if (msg.sender != CLPR_SERVICE) revert OnlyService();
        Source storage s = sources[channelId];
        if (s.ledger == bytes32(0) || block.timestamp < s.activeAt) revert UnknownSource();
        (uint8 version, uint8 kind) = SettleTypes.header(messageData);
        if (version != SettleTypes.VERSION) revert UnsupportedMessage();
        bytes32 senderHash = keccak256(sender);
        if (kind == SettleTypes.MSG_DEPOSIT) {
            if (senderHash != s.depositSender) revert UnauthorizedSender();
            (SettleTypes.Quote memory q, bytes memory sig, uint64 depositedAt) = SettleTypes.decodeDeposit(messageData);
            // The quote must name this ledger and the contract that sent it.
            bool fromHere = q.srcLedger == s.ledger && SettleTypes.isAddress(q.depositApp)
                && keccak256(_addressBytes(q.depositApp)) == senderHash;
            _open(q, sig, depositedAt, fromHere);
        } else if (kind == SettleTypes.MSG_DELIVERY) {
            if (senderHash != s.deliverySender) revert UnauthorizedSender();
            _delivered(s.ledger, SettleTypes.decodeDelivery(messageData));
        } else {
            revert UnsupportedMessage();
        }
        return "";
    }

    /// @inheritdoc IClprApplication
    /// @dev The order book sends no messages, so there is nothing to handle.
    function onClprResponse(bytes32, uint64, uint8, bytes calldata) external view {
        if (msg.sender != CLPR_SERVICE) revert OnlyService();
    }

    // ═════════════════════════════════════════════════════════════════════
    // Payment proofs (chains without a CLPR Service)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Open the order of `q` from a proven payment of `q.amountIn` to `q.payTo` on `q.srcLedger` that
    ///         carries the order id. Anyone may submit it (usually the user's wallet).
    function openByPayment(SettleTypes.Quote calldata q, bytes calldata sig, bytes calldata proof)
        external
        nonReentrant
        returns (bytes32 id)
    {
        id = SettleTypes.orderId(DOMAIN_SEPARATOR, q);
        if (orders[id].status != Status.NONE) revert PaymentReplayed();
        // A quote for a `SettleDeposit` contract is opened only by that contract's CLPR message.
        if (q.depositApp != bytes32(0)) revert PaymentMismatch();
        ISettlePaymentProver.Payment memory p = _prove(q.srcLedger, proof);
        if (
            p.memo != id || p.to != q.payTo || p.asset != q.assetIn || p.amount < q.amountIn || p.timestamp > q.expiry
                || q.expiry >= q.deadline || (q.user != bytes32(0) && p.from != q.user)
        ) revert PaymentMismatch();
        _open(q, sig, p.timestamp, true);
    }

    /// @notice Close order `id` from a proven payment on its destination ledger that carries the order id.
    function closeByPayment(bytes32 id, bytes calldata proof) external nonReentrant {
        Order storage o = orders[id];
        if (o.status != Status.OPEN) revert NotOpen();
        ISettlePaymentProver.Payment memory p = _prove(o.dstLedger, proof);
        if (
            p.memo != id || p.to != o.recipient || p.asset != o.assetOut || p.amount < o.amountOut
                || p.timestamp > o.deadline
        ) revert PaymentMismatch();
        _close(id, o, keccak256(abi.encode(p)), p.timestamp);
    }

    function _prove(bytes32 ledger, bytes calldata proof) internal returns (ISettlePaymentProver.Payment memory p) {
        Prover storage pr = provers[ledger];
        if (address(pr.prover) == address(0) || block.timestamp < pr.activeAt) revert NoProver();
        p = pr.prover.provePayment(proof);
        if (p.ledger != ledger) revert PaymentMismatch();
        bytes32 key = keccak256(abi.encode(ledger, p.txId));
        if (paymentUsed[key]) revert PaymentReplayed();
        paymentUsed[key] = true;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Orders
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Close an open order with a delivery that was proven before the order was opened.
    function closeWithRecordedDelivery(bytes32 ledger, SettleTypes.Delivery calldata d) external nonReentrant {
        Order storage o = orders[d.orderId];
        if (o.status != Status.OPEN) revert NotOpen();
        bytes32 h = deliveryHash(ledger, d);
        if (!deliverySeen[d.orderId][h]) revert UnknownDelivery();
        if (!_matches(o, ledger, d)) revert NotMatching();
        _close(d.orderId, o, h, d.deliveredAt);
    }

    /// @notice After the deadline plus `PROOF_GRACE` with no proven delivery: pay the user cover + penalty from
    ///         the Connector's bond. Anyone may call; the payment always goes to the order's `refundTo`.
    function claimDefault(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.status != Status.OPEN) revert NotOpen();
        if (block.timestamp <= uint256(o.deadline) + PROOF_GRACE) revert DeadlineNotPassed();
        o.status = Status.DEFAULTED;
        uint256 paid = _slash(o);
        emit OrderDefaulted(id, o.refundTo, o.coverAsset, paid);
        _pay(o.coverAsset, o.refundTo, paid);
    }

    /// @notice The Connector gives up on an open order before delivering: the user is paid cover + penalty now.
    function cancelOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.status != Status.OPEN) revert NotOpen();
        if (msg.sender != o.connector) revert NotConnector();
        o.status = Status.CANCELLED;
        uint256 paid = _slash(o);
        emit OrderCancelled(id, o.refundTo, o.coverAsset, paid);
        _pay(o.coverAsset, o.refundTo, paid);
    }

    /// @notice Pull a payout that could not be pushed.
    function withdrawOwed(address asset) external nonReentrant {
        uint256 amt = owed[msg.sender][asset];
        if (amt == 0) revert NothingPending();
        owed[msg.sender][asset] = 0;
        totalOwed[asset] -= amt;
        _transferOut(asset, msg.sender, amt);
    }

    /// @notice Hedera only: associate this contract with every HTS cover asset so it can hold them (HIP-206
    ///         precompile at 0x167). Anyone may call; a failure (e.g. already associated) is reported, not raised.
    function associateCoverAssets() external {
        for (uint256 i = 0; i < _coverAssets.length; i++) {
            address t = _coverAssets[i];
            if (t == address(0)) continue;
            (bool ok, bytes memory ret) =
                HTS_PRECOMPILE.call(abi.encodeWithSignature("associateToken(address,address)", address(this), t));
            int64 code = ok && ret.length >= 32 ? int64(abi.decode(ret, (int256))) : int64(-1);
            emit TokenAssociated(t, code);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Admin: sources and payment provers (add-only, after notice)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Register the CLPR Channel `channelId` as the source for `ledgerId`, with the `SettleDeposit` and
    ///         `SettleDelivery` contracts (as the CLPR sender bytes) allowed to speak for it. Effective after
    ///         `SOURCE_NOTICE`; one source per ledger and per Channel, never replaced.
    function proposeSource(
        bytes32 channelId,
        bytes32 ledger,
        bytes calldata depositSender,
        bytes calldata deliverySender
    ) external onlyAdmin {
        if (channelId == bytes32(0) || ledger == bytes32(0)) revert BadParams();
        if (sources[channelId].ledger != bytes32(0) || channelOfLedger[ledger] != bytes32(0)) revert SourceExists();
        uint64 at = uint64(block.timestamp) + SOURCE_NOTICE;
        sources[channelId] = Source({
            ledger: ledger,
            depositSender: depositSender.length == 0 ? bytes32(0) : keccak256(depositSender),
            deliverySender: deliverySender.length == 0 ? bytes32(0) : keccak256(deliverySender),
            activeAt: at
        });
        channelOfLedger[ledger] = channelId;
        emit SourceProposed(channelId, ledger, depositSender, deliverySender, at);
    }

    /// @notice Register the payment prover for `ledger`. Effective after `SOURCE_NOTICE`; one per ledger.
    function proposeProver(bytes32 ledger, ISettlePaymentProver prover) external onlyAdmin {
        if (ledger == bytes32(0) || address(prover) == address(0)) revert BadParams();
        if (address(provers[ledger].prover) != address(0)) revert SourceExists();
        uint64 at = uint64(block.timestamp) + SOURCE_NOTICE;
        provers[ledger] = Prover({prover: prover, activeAt: at});
        emit ProverProposed(ledger, address(prover), at);
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert OnlyAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Give up the admin role for good: no further sources or provers.
    function renounceAdmin() external onlyAdmin {
        emit AdminTransferred(admin, address(0));
        admin = address(0);
        pendingAdmin = address(0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Internals
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Open the order of `q`. Never reverts: a quote the Connector did not sign, or one proven by the wrong
    ///      source, is recorded as REJECTED; a repeat is ignored.
    function _open(SettleTypes.Quote memory q, bytes memory sig, uint64 depositedAt, bool fromHere) internal {
        bytes32 id = SettleTypes.orderId(DOMAIN_SEPARATOR, q);
        Order storage o = orders[id];
        if (o.status != Status.NONE) {
            emit DuplicateDeposit(id, q.srcLedger);
            return;
        }
        Reject why = Reject.NONE;
        if (!fromHere) {
            why = Reject.WRONG_SOURCE;
        } else if (connectors[q.connector].registeredAt == 0) {
            why = Reject.UNKNOWN_CONNECTOR;
        } else {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(id, sig);
            if (err != ECDSA.RecoverError.NoError || !isValidSigner(q.connector, signer, q.issuedAt, q.expiry)) {
                why = Reject.BAD_SIGNATURE;
            }
        }
        if (why != Reject.NONE) {
            o.status = Status.REJECTED;
            o.connector = q.connector;
            emit OrderRejected(id, q.connector, why);
            return;
        }

        uint256 need = owedFor(q.coverAmount);
        uint256 got;
        // A cover asset outside the bond assets cannot be reserved; the Connector signed it, so the order still
        // opens and the shortfall is counted against the Connector.
        if (isCoverAsset[q.coverAsset]) got = _reserve(bonds[q.connector][q.coverAsset], need);

        o.connector = q.connector;
        o.status = Status.OPEN;
        o.deadline = q.deadline;
        o.coverAsset = q.coverAsset;
        o.openedAt = depositedAt;
        o.refundTo = q.refundTo;
        o.dstLedger = q.dstLedger;
        o.assetOut = q.assetOut;
        o.recipient = q.recipient;
        o.amountOut = q.amountOut;
        o.owedOnDefault = need;
        o.reserved = got;
        if (got < need) {
            connectors[q.connector].shortfalls++;
            emit CoverShortfall(id, q.connector, need, got);
        }
        emit OrderOpened(id, q.connector, q.refundTo, q.srcLedger, q.dstLedger, q.coverAsset, need, got, q.deadline);
    }

    /// @dev Reserve up to `need`: free bond first, then a pending withdrawal.
    function _reserve(Bond storage b, uint256 need) internal returns (uint256 got) {
        uint256 free = b.total - b.reserved - b.pendingWithdraw;
        got = need <= free ? need : free;
        if (got < need && b.pendingWithdraw > 0) {
            uint256 more = need - got;
            if (more > b.pendingWithdraw) more = b.pendingWithdraw;
            b.pendingWithdraw -= more;
            got += more;
        }
        b.reserved += got;
    }

    /// @dev A delivery proven on `ledger`. Never reverts.
    function _delivered(bytes32 ledger, SettleTypes.Delivery memory d) internal {
        bytes32 h = deliveryHash(ledger, d);
        Order storage o = orders[d.orderId];
        if (o.status == Status.NONE) {
            // The deposit proof has not arrived yet; keep the delivery for {closeWithRecordedDelivery}.
            deliverySeen[d.orderId][h] = true;
            emit DeliveryRecorded(d.orderId, h, ledger);
        } else if (o.status != Status.OPEN) {
            emit LateDelivery(d.orderId, h, o.status);
        } else if (!_matches(o, ledger, d)) {
            emit DeliveryMismatch(d.orderId, h);
        } else {
            _close(d.orderId, o, h, d.deliveredAt);
        }
    }

    function _matches(Order storage o, bytes32 ledger, SettleTypes.Delivery memory d) internal view returns (bool) {
        return ledger == o.dstLedger && d.asset == o.assetOut && d.recipient == o.recipient && d.amount >= o.amountOut
            && d.deliveredAt <= o.deadline;
    }

    function _close(bytes32 id, Order storage o, bytes32 h, uint64 deliveredAt) internal {
        o.status = Status.DELIVERED;
        uint256 r = o.reserved;
        if (r > 0) bonds[o.connector][o.coverAsset].reserved -= r;
        emit OrderDelivered(id, h, deliveredAt);
    }

    /// @dev Take the order's reservation out of the bond; returns what the user is paid.
    function _slash(Order storage o) internal returns (uint256 r) {
        r = o.reserved;
        if (r > 0) {
            Bond storage b = bonds[o.connector][o.coverAsset];
            b.reserved -= r;
            b.total -= r;
        }
    }

    /// @dev Push `amount` to `to`, crediting {owed} if the push fails.
    function _pay(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (asset == address(0)) {
            (ok,) = to.call{value: amount, gas: PUSH_GAS}("");
        } else {
            (bool s, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            ok = s && (ret.length == 0 ? asset.code.length > 0 : (ret.length == 32 && abi.decode(ret, (bool))));
        }
        if (ok) {
            emit Paid(to, asset, amount);
        } else {
            owed[to][asset] += amount;
            totalOwed[asset] += amount;
            emit Owed(to, asset, amount);
        }
    }

    function _transferOut(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /// @dev The 20-byte form of a left-padded address (CLPR sender bytes of an EVM contract).
    function _addressBytes(bytes32 b) internal pure returns (bytes memory) {
        return abi.encodePacked(address(uint160(uint256(b))));
    }
}
