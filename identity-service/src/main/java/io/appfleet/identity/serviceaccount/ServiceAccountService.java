package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.common.ApiExceptions.ConflictException;
import io.appfleet.identity.common.ApiExceptions.InvalidFieldException;
import io.appfleet.identity.common.ApiExceptions.NotFoundException;
import io.appfleet.identity.rbac.PermissionResolver;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.AccountView;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.CreatedAccount;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.IssuedKey;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.KeyView;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * What a team administrator does with the service accounts of their team. Every method takes the team id from the path and
 * looks the account up WITH it, so an account of another team is simply not found.
 */
@Service
public class ServiceAccountService {

    static final String MANAGE = "user:manage";

    private final TeamRepository teams;
    private final UserRepository users;
    private final RoleRepository roles;
    private final PermissionResolver resolver;
    private final ServiceAccountRepository accounts;
    private final ApiKeyRepository keys;
    private final ServiceAccountProperties properties;

    public ServiceAccountService(TeamRepository teams, UserRepository users, RoleRepository roles, PermissionResolver resolver,
                                 ServiceAccountRepository accounts, ApiKeyRepository keys, ServiceAccountProperties properties) {
        this.teams = teams;
        this.users = users;
        this.roles = roles;
        this.resolver = resolver;
        this.accounts = accounts;
        this.keys = keys;
        this.properties = properties;
    }

    /** Creates the account and its first key. The key is in the result and nowhere else, ever. */
    @Transactional
    public CreatedAccount create(UUID teamId, UUID actorId, String name, String roleName) {
        Team team = teams.findById(teamId).orElseThrow(() -> new NotFoundException("team"));
        AppUser actor = actor(actorId);
        Role role = roles.findByName(roleName).orElseThrow(() -> new InvalidFieldException("role", "unknown role"));
        if (resolver.permissionsFor(role.getName()).contains(MANAGE))
            throw new InvalidFieldException("role", "a service account cannot hold a role that manages users");
        if (accounts.existsByTeam_IdAndName(teamId, name)) throw new ConflictException("a service account with that name exists in the team");
        ServiceAccount account;
        try {
            account = accounts.save(new ServiceAccount(team, role, name, actor));
        } catch (DataIntegrityViolationException e) {
            throw new ConflictException("a service account with that name exists in the team");   // raced past the check; the unique key decided
        }
        IssuedKey issued = issueKey(account, actor);
        return new CreatedAccount(view(account, keys.findByTeamId(teamId).stream()
                .filter(k -> k.getServiceAccount().getId().equals(account.getId())).toList()), issued);
    }

    @Transactional(readOnly = true)
    public List<AccountView> list(UUID teamId) {
        teams.findById(teamId).orElseThrow(() -> new NotFoundException("team"));
        Map<UUID, List<ApiKey>> byAccount = keys.findByTeamId(teamId).stream()
                .collect(Collectors.groupingBy(k -> k.getServiceAccount().getId()));
        return accounts.findByTeam_IdOrderByNameAsc(teamId).stream().map(a -> view(a, byAccount.getOrDefault(a.getId(), List.of()))).toList();
    }

    /** A second key, for rotation: both work until the old one is revoked. At most {@code maxActiveKeys} at a time. */
    @Transactional
    public IssuedKey addKey(UUID teamId, UUID accountId, UUID actorId) {
        ServiceAccount account = account(teamId, accountId);
        if (!account.isActive()) throw new ConflictException("the service account is disabled");
        if (keys.countByServiceAccount_IdAndStatus(accountId, ApiKeyStatus.ACTIVE) >= properties.maxActiveKeys())
            throw new ConflictException("the service account already has " + properties.maxActiveKeys() + " active keys; revoke one first");
        return issueKey(account, actor(actorId));
    }

    /** Revoking twice changes nothing. A key of another account (or team) is not found. */
    @Transactional
    public void revokeKey(UUID teamId, UUID accountId, UUID keyId) {
        account(teamId, accountId);
        keys.findByIdAndServiceAccount_Id(keyId, accountId).orElseThrow(() -> new NotFoundException("key")).revoke();
    }

    /** The account can never get a token again, whatever its keys say. The tokens already issued live out their few minutes. */
    @Transactional
    public AccountView disable(UUID teamId, UUID accountId) {
        ServiceAccount account = account(teamId, accountId);
        account.disable();
        return view(account, keys.findByTeamId(teamId).stream().filter(k -> k.getServiceAccount().getId().equals(accountId)).toList());
    }

    private ServiceAccount account(UUID teamId, UUID accountId) {
        return accounts.findByIdAndTeam_Id(accountId, teamId).orElseThrow(() -> new NotFoundException("service account"));
    }

    /** The caller of these endpoints is a user (the guard needs user:manage, which no service account can hold), so the id is a user id. */
    private AppUser actor(UUID actorId) {
        return users.findById(actorId).orElseThrow(() -> new NotFoundException("user"));
    }

    private IssuedKey issueKey(ServiceAccount account, AppUser actor) {
        ApiKeyGenerator.Generated generated = ApiKeyGenerator.generate();
        ApiKey saved = keys.save(new ApiKey(account, generated.prefix(), generated.hash(), actor));
        return new IssuedKey(saved.getId(), generated.prefix(), generated.key());
    }

    private static AccountView view(ServiceAccount a, List<ApiKey> accountKeys) {
        List<KeyView> views = accountKeys.stream()
                .map(k -> new KeyView(k.getId(), k.getPrefix(), k.getStatus().name(), k.getCreatedAt(), k.getRevokedAt(), k.getLastUsedAt()))
                .toList();
        return new AccountView(a.getId(), a.getTeam().getId(), a.getName(), a.getRole().getName(), a.getStatus().name(), a.getCreatedAt(), a.getDisabledAt(), views);
    }
}